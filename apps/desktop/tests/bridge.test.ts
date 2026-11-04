import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionRouter } from '@nienie/bridge-core';
import { createBridgeRegistry } from '../src/bridge.js';

describe('desktop bridge composition', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('registers the MVP agents', async () => {
    const registry = createBridgeRegistry({ opencode: { baseUrl: 'http://127.0.0.1:1' } });
    cleanups.push(() => registry.dispose());
    const agents = await registry.detectAll();
    expect(agents.map((agent) => agent.id)).toEqual(['opencode', 'codex']);
  });

  it('completes the OpenCode -> Bridge -> canonical events loop', async () => {
    const sseClients = new Set<ServerResponse>();

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/global/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, version: '0.15.2' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'ses_bridge_loop',
            directory: '/workspace/nienie',
            title: 'E2E Loop',
            time: { created: 1762216000000, updated: 1762216000000 },
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session/ses_bridge_loop/prompt_async') {
        res.writeHead(204);
        res.end();
        for (const client of sseClients) {
          client.write(
            `data: ${JSON.stringify({
              type: 'message.part.delta',
              properties: {
                sessionID: 'ses_bridge_loop',
                messageID: 'msg_1',
                partID: 'part_1',
                field: 'text',
                delta: 'Loop verified',
              },
            })}\n\n`,
          );
          client.write(
            `data: ${JSON.stringify({
              type: 'session.idle',
              properties: { sessionID: 'ses_bridge_loop' },
            })}\n\n`,
          );
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of sseClients) client.end();
          server.close(() => resolve());
        }),
    );

    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');

    const registry = createBridgeRegistry({
      opencode: { baseUrl: `http://127.0.0.1:${addr.port}`, machineId: 'desktop_1' },
    });
    cleanups.push(() => registry.dispose());

    const router = new SessionRouter(registry);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    router.onEvent((event) => events.push({ type: event.type, payload: event.payload }));

    const session = await router.createSession('opencode', { title: 'E2E Loop' });
    await router.sendMessage(session, 'ping');

    const deadline = Date.now() + 2000;
    while (events.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    expect(events).toEqual([
      { type: 'text_delta', payload: { delta: 'Loop verified' } },
      { type: 'status', payload: { status: 'idle', detail: 'Session is idle' } },
    ]);
  });
});
