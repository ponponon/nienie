import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  createDesktopPreloadApi,
  registerDesktopIpcHandlers,
  type DesktopBridgeController,
} from './controller.js';
import { renderDesktopAppHtml } from './renderer.js';

export type DesktopPreviewServerOptions = {
  controller: DesktopBridgeController;
  host?: string | undefined;
  port?: number | undefined;
};

export class DesktopPreviewServer {
  private readonly controller: DesktopBridgeController;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly ipcHandlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
  >();
  private httpServer: Server | undefined;

  constructor(options: DesktopPreviewServerOptions) {
    this.controller = options.controller;
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 0;

    registerDesktopIpcHandlers(
      {
        handle: (channel, listener) => {
          this.ipcHandlers.set(channel, listener);
        },
      },
      this.controller,
    );
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.requestedPort, this.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.httpServer = server;
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('DesktopPreviewServer is not listening on a TCP port');
    }
    return {
      host: this.host,
      port: addr.port,
      url: `http://${this.host}:${addr.port}`,
    };
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const baseHtml = renderDesktopAppHtml(this.controller.getState());
      const httpShimScript = `<script>
    if (!window.nienieDesktop) {
      const invoke = async (channel, ...args) => {
        const res = await fetch('/api/ipc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel, args }),
        });
        const data = await res.json();
        window.location.reload();
        return data;
      };
      window.nienieDesktop = ${ JSON.stringify(Object.keys(createDesktopPreloadApi({ invoke: async () => ({}) }))) }.reduce((acc, method) => {
        const map = {
          getState: 'desktop:get-state',
          startBridge: 'desktop:start-bridge',
          stopBridge: 'desktop:stop-bridge',
          refreshAgents: 'desktop:refresh-agents',
          refreshPairing: 'desktop:refresh-pairing',
          setRelay: 'desktop:set-relay',
          revokeDevice: 'desktop:revoke-device',
        };
        acc[method] = (...args) => invoke(map[method], ...args);
        return acc;
      }, {});
    }
  </script>`;
      const injectedHtml = baseHtml.replace('</head>', `${httpShimScript}\n</head>`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(injectedHtml);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.controller.getState()));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ipc') {
      const body = (await readJsonBody(req)) as { channel?: string; args?: unknown[] };
      const handler = body.channel ? this.ipcHandlers.get(body.channel) : undefined;
      if (!handler) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unknown IPC channel' }));
        return;
      }
      try {
        const result = await handler({}, ...(Array.isArray(body.args) ? body.args : []));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : 'IPC handler failed',
          }),
        );
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
