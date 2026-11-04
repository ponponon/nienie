import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import { OpenClawAdapter } from '../src/index.js';

describe('OpenClawAdapter', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('connects to OpenClaw Gateway HTTP endpoints and normalizes session events', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: '2.1.0' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/sessions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'oclaw_ses_1', title: 'Claw Task' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/sessions/oclaw_ses_1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            events: [
              { type: 'text_delta', payload: { delta: 'Hello from OpenClaw' } },
              { type: 'status', payload: { status: 'idle', detail: 'Completed' } },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP port');

    const adapter = new OpenClawAdapter({ baseUrl: `http://127.0.0.1:${addr.port}` });
    const info = await adapter.detect();
    expect(info).toMatchObject({ id: 'openclaw', available: true, version: '2.1.0' });

    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    const session = await adapter.createSession({ title: 'Claw Task' });
    await adapter.sendMessage(session.id, 'ping');

    expect(events.map((e) => ({ seq: e.sequence, type: e.type, payload: e.payload }))).toEqual([
      { seq: 1, type: 'text_delta', payload: { delta: 'Hello from OpenClaw' } },
      { seq: 2, type: 'status', payload: { status: 'idle', detail: 'Completed' } },
    ]);
  });
});
