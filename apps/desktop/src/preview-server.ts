import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDesktopPreloadApi,
  DESKTOP_PRELOAD_METHODS,
  registerDesktopIpcHandlers,
  type DesktopBridgeController,
} from './controller.js';
import {
  renderDesktopAppHtml,
  type DesktopLocale,
} from './renderer.js';

export type DesktopPreviewServerOptions = {
  controller: DesktopBridgeController;
  host?: string | undefined;
  port?: number | undefined;
  liveRendererPath?: string | undefined;
};

export class DesktopPreviewServer {
  private readonly controller: DesktopBridgeController;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly liveRendererPath: string | undefined;
  private readonly ipcHandlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
  >();
  private readonly hotReloadClients = new Set<ServerResponse>();
  private liveWatcher: FSWatcher | undefined;
  private httpServer: Server | undefined;

  constructor(options: DesktopPreviewServerOptions) {
    this.controller = options.controller;
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 0;
    this.liveRendererPath = options.liveRendererPath;

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
    if (this.liveRendererPath && existsSync(this.liveRendererPath)) {
      try {
        this.liveWatcher = watch(this.liveRendererPath, () => {
          for (const client of this.hotReloadClients) {
            client.write('data: reload\n\n');
          }
        });
      } catch {
        // Ignore watch errors
      }
    }
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
    if (this.liveWatcher) {
      this.liveWatcher.close();
      this.liveWatcher = undefined;
    }
    for (const client of this.hotReloadClients) {
      client.end();
    }
    this.hotReloadClients.clear();
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async renderHtml(
    state: ReturnType<DesktopBridgeController['getState']>,
    locale: DesktopLocale,
  ): Promise<string> {
    if (this.liveRendererPath && existsSync(this.liveRendererPath)) {
      try {
        const mtime = statSync(this.liveRendererPath).mtimeMs;
        const mod = (await import(
          `${pathToFileURL(this.liveRendererPath).href}?t=${mtime}`
        )) as { renderDesktopAppHtml?: typeof renderDesktopAppHtml };
        if (typeof mod.renderDesktopAppHtml === 'function') {
          return mod.renderDesktopAppHtml(state, { locale });
        }
      } catch {
        // Fall back to static renderer
      }
    }
    return renderDesktopAppHtml(state, { locale });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.host}`);

    if (req.method === 'GET' && url.pathname === '/api/hot-reload') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('data: connected\n\n');
      this.hotReloadClients.add(res);
      req.on('close', () => this.hotReloadClients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const rawLang = url.searchParams.get('lang');
      if (rawLang === 'zh' || rawLang === 'en' || rawLang === 'ja' || rawLang === 'ko') {
        this.controller.setLocale(rawLang);
      }
      const state = this.controller.getState();
      const baseHtml = await this.renderHtml(state, state.locale);
      const httpShimScript = `<script>
    if (typeof EventSource !== 'undefined') {
      const es = new EventSource('/api/hot-reload');
      es.onmessage = (ev) => {
        if (ev.data === 'reload') window.location.reload();
      };
    }
    if (!window.nienieDesktop) {
      const invoke = async (channel, ...args) => {
        const res = await fetch('/api/ipc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel, args }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error((data && data.error) || 'IPC call failed');
        }
        return data;
      };
      window.nienieDesktop = ${ JSON.stringify(Object.keys(createDesktopPreloadApi({ invoke: async () => ({}) }))) }.reduce((acc, method) => {
        const map = ${ JSON.stringify(DESKTOP_PRELOAD_METHODS) };
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

    if (req.method === 'GET' && url.pathname === '/assets/desktop-client.js') {
      const candidates = [
        resolve(process.cwd(), 'apps/desktop/dist/desktop-client.js'),
        resolve(process.cwd(), 'dist/desktop-client.js'),
      ];
      const found = candidates.find((p) => existsSync(p));
      if (found) {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(readFileSync(found));
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/assets/nienie-logo.png') {
      const candidates = [
        resolve(process.cwd(), 'apps/desktop/assets/nienie-logo.png'),
        resolve(process.cwd(), 'assets/branding/nienie-logo-512.png'),
      ];
      const found = candidates.find((p) => existsSync(p));
      if (found) {
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=3600',
        });
        res.end(readFileSync(found));
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/assets/wechat-appreciate.jpg') {
      const candidates = [
        resolve(process.cwd(), 'apps/desktop/assets/wechat-appreciate.jpg'),
        resolve(process.cwd(), 'assets/wechat-appreciate.jpg'),
      ];
      const found = candidates.find((p) => existsSync(p));
      if (found) {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=3600' });
        res.end(readFileSync(found));
        return;
      }
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
