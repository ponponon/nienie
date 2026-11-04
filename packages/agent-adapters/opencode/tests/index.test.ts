import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import {
  OpenCodeAdapter,
  OpenCodeEventNormalizer,
  parseSseStream,
} from '../src/index.js';
import {
  OPENCODE_HEALTH_FIXTURE,
  OPENCODE_SESSION_STATUS_FIXTURE,
  OPENCODE_SESSIONS_FIXTURE,
  OPENCODE_STREAM_LIFECYCLE_FIXTURE,
} from './fixtures/opencode-events.fixture.js';

describe('OpenCodeEventNormalizer', () => {
  it('normalizes an OpenCode SSE lifecycle fixture into ordered Nienie canonical events', () => {
    let counter = 0;
    const normalizer = new OpenCodeEventNormalizer({
      machineId: 'machine_dev',
      now: () => new Date('2026-11-04T08:00:00.000Z'),
      idGenerator: () => `cevt_${++counter}`,
    });

    const canonicalEvents: CanonicalAgentEvent[] = [];
    for (const raw of OPENCODE_STREAM_LIFECYCLE_FIXTURE) {
      canonicalEvents.push(...normalizer.normalize(raw));
    }

    expect(canonicalEvents.map((e) => ({ seq: e.sequence, type: e.type, payload: e.payload }))).toEqual([
      {
        seq: 1,
        type: 'status',
        payload: { status: 'running', detail: 'Session is busy' },
      },
      {
        seq: 2,
        type: 'thinking_delta',
        payload: { delta: '先检查 package.json 中的测试脚本' },
      },
      {
        seq: 3,
        type: 'text_delta',
        payload: { delta: '我将运行测试' },
      },
      {
        seq: 4,
        type: 'text_delta',
        payload: { delta: '来验证当前状态。' },
      },
      {
        seq: 5,
        type: 'tool_use',
        payload: {
          toolCallId: 'call_bash_01',
          name: 'bash',
          input: {
            command: 'pnpm test',
            apiKey: '[REDACTED]',
          },
        },
      },
      {
        seq: 6,
        type: 'tool_result',
        payload: {
          toolCallId: 'call_bash_01',
          content: 'Test Files 5 passed (5)',
          isError: false,
        },
      },
      {
        seq: 7,
        type: 'status',
        payload: {
          status: 'waiting',
          detail: 'Permission requested: bash',
          permissionId: 'perm_1',
          permission: 'bash',
          patterns: ['rm -rf dist'],
        },
      },
      {
        seq: 8,
        type: 'usage',
        payload: {
          inputTokens: 1500,
          outputTokens: 420,
          reasoningTokens: 120,
          costUsd: 0.0142,
        },
      },
      {
        seq: 9,
        type: 'error',
        payload: {
          code: 'APIError',
          message: 'Rate limit exceeded',
          retryable: true,
        },
      },
      {
        seq: 10,
        type: 'status',
        payload: { status: 'idle', detail: 'Session is idle' },
      },
    ]);

    for (const event of canonicalEvents) {
      expect(event.version).toBe(1);
      expect(event.agentId).toBe('opencode');
      expect(event.machineId).toBe('machine_dev');
      expect(event.sessionId).toBe('ses_alpha');
      expect(event.timestamp).toBe('2026-11-04T08:00:00.000Z');
    }
  });

  it('pairs tool_use and tool_result even when OpenCode emits a completed tool part directly and handles tool errors', () => {
    const normalizer = new OpenCodeEventNormalizer();

    const completedDirectly = normalizer.normalize({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_tool_direct',
          sessionID: 'ses_beta',
          messageID: 'msg_2',
          type: 'tool',
          callID: 'call_read_1',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: '/workspace/README.md' },
            output: '# Nienie',
            title: 'Read README',
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      },
    });

    expect(completedDirectly).toHaveLength(2);
    expect(completedDirectly[0]).toMatchObject({
      sessionId: 'ses_beta',
      sequence: 1,
      type: 'tool_use',
      payload: {
        toolCallId: 'call_read_1',
        name: 'read',
        input: { filePath: '/workspace/README.md' },
      },
    });
    expect(completedDirectly[1]).toMatchObject({
      sessionId: 'ses_beta',
      sequence: 2,
      type: 'tool_result',
      payload: {
        toolCallId: 'call_read_1',
        content: '# Nienie',
        isError: false,
      },
    });

    const erroredTool = normalizer.normalize({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_tool_err',
          sessionID: 'ses_beta',
          messageID: 'msg_2',
          type: 'tool',
          callID: 'call_bash_err',
          tool: 'bash',
          state: {
            status: 'error',
            input: { command: 'false' },
            error: 'Command exited with code 1',
            time: { start: 3, end: 4 },
          },
        },
      },
    });

    expect(erroredTool).toHaveLength(2);
    expect(erroredTool[0]).toMatchObject({
      sessionId: 'ses_beta',
      sequence: 3,
      type: 'tool_use',
      payload: {
        toolCallId: 'call_bash_err',
        name: 'bash',
        input: { command: 'false' },
      },
    });
    expect(erroredTool[1]).toMatchObject({
      sessionId: 'ses_beta',
      sequence: 4,
      type: 'tool_result',
      payload: {
        toolCallId: 'call_bash_err',
        content: 'Command exited with code 1',
        isError: true,
      },
    });
  });

  it('normalizes OpenCode v2 session.next.* and global payload wrapper events', () => {
    const normalizer = new OpenCodeEventNormalizer();

    const events = [
      ...normalizer.normalize({
        directory: '/workspace/nienie',
        payload: {
          id: 'evt_v2_1',
          type: 'session.next.text.delta',
          properties: {
            timestamp: 1762214500000,
            sessionID: 'ses_v2',
            assistantMessageID: 'msg_a1',
            textID: 'txt_1',
            delta: 'Hello from v2',
          },
        },
      }),
      ...normalizer.normalize({
        id: 'evt_v2_2',
        type: 'session.next.reasoning.delta',
        properties: {
          timestamp: 1762214501000,
          sessionID: 'ses_v2',
          assistantMessageID: 'msg_a1',
          reasoningID: 'rsn_1',
          delta: 'Thinking in v2',
        },
      }),
      ...normalizer.normalize({
        id: 'evt_v2_3',
        type: 'session.next.tool.called',
        properties: {
          timestamp: 1762214502000,
          sessionID: 'ses_v2',
          assistantMessageID: 'msg_a1',
          callID: 'call_v2_1',
          name: 'glob',
          input: { pattern: '**/*.ts' },
        },
      }),
      ...normalizer.normalize({
        id: 'evt_v2_4',
        type: 'session.next.tool.success',
        properties: {
          timestamp: 1762214503000,
          sessionID: 'ses_v2',
          assistantMessageID: 'msg_a1',
          callID: 'call_v2_1',
          content: 'src/index.ts',
        },
      }),
    ];

    expect(events.map((e) => ({ type: e.type, payload: e.payload }))).toEqual([
      { type: 'text_delta', payload: { delta: 'Hello from v2' } },
      { type: 'thinking_delta', payload: { delta: 'Thinking in v2' } },
      {
        type: 'tool_use',
        payload: { toolCallId: 'call_v2_1', name: 'glob', input: { pattern: '**/*.ts' } },
      },
      {
        type: 'tool_result',
        payload: { toolCallId: 'call_v2_1', content: 'src/index.ts', isError: false },
      },
    ]);
  });
});

describe('parseSseStream', () => {
  it('parses chunked SSE frames, ignores comments, and yields JSON payloads', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ': keep-alive\n\n',
      'event: message\ndata: {"id":"1","type":"session.idle",',
      '"properties":{"sessionID":"ses_1"}}\r\n\r\n',
      'data: {"id":"2","type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"busy"}}}\n\n',
    ];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const parsed: unknown[] = [];
    for await (const item of parseSseStream(stream)) {
      parsed.push(item);
    }

    expect(parsed).toEqual([
      { id: '1', type: 'session.idle', properties: { sessionID: 'ses_1' } },
      { id: '2', type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    ]);
  });
});

describe('OpenCodeAdapter', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('returns available=false when OpenCode server is unreachable', async () => {
    const adapter = new OpenCodeAdapter({ baseUrl: 'http://127.0.0.1:1' });
    const info = await adapter.detect();
    expect(info.id).toBe('opencode');
    expect(info.name).toBe('OpenCode');
    expect(info.available).toBe(false);
    expect(info.capabilities.streaming).toBe(true);
    expect(info.capabilities.sessionResume).toBe(true);
  });

  it('connects to an OpenCode server for detection, session lifecycle, messaging, cancellation, and SSE streaming', async () => {
    const receivedPrompts: Array<{ sessionId: string; body: unknown; auth?: string | undefined }> = [];
    const abortedSessions: string[] = [];
    const sseClients = new Set<ServerResponse>();

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/global/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(OPENCODE_HEALTH_FIXTURE));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(OPENCODE_SESSIONS_FIXTURE));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/session/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(OPENCODE_SESSION_STATUS_FIXTURE));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session') {
        const body = await readJsonBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'ses_created_1',
            projectID: 'proj_1',
            directory: url.searchParams.get('directory') ?? '/workspace/nienie',
            title: (body as { title?: string })?.title ?? 'New session',
            version: '0.15.2',
            time: {
              created: 1762215000000,
              updated: 1762215000000,
            },
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/session/')) {
        const sessionId = url.pathname.slice('/session/'.length);
        const found = OPENCODE_SESSIONS_FIXTURE.find((s) => s.id === sessionId);
        if (!found) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ name: 'NotFoundError', data: { message: 'Session not found' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(found));
        return;
      }

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (req.method === 'POST' && promptMatch) {
        const sessionId = promptMatch[1]!;
        const body = await readJsonBody(req);
        receivedPrompts.push({
          sessionId,
          body,
          auth: req.headers.authorization,
        });
        res.writeHead(204);
        res.end();

        for (const client of sseClients) {
          client.write(
            `event: message\ndata: ${JSON.stringify({
              id: 'evt_live_1',
              type: 'session.status',
              properties: { sessionID: sessionId, status: { type: 'busy' } },
            })}\n\n`,
          );
          client.write(
            `event: message\ndata: ${JSON.stringify({
              id: 'evt_live_2',
              type: 'message.part.delta',
              properties: {
                sessionID: sessionId,
                messageID: 'msg_live_1',
                partID: 'part_live_1',
                field: 'text',
                delta: '收到你的消息！',
              },
            })}\n\n`,
          );
          client.write(
            `event: message\ndata: ${JSON.stringify({
              id: 'evt_live_3',
              type: 'session.idle',
              properties: { sessionID: sessionId },
            })}\n\n`,
          );
        }
        return;
      }

      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (req.method === 'POST' && abortMatch) {
        abortedSessions.push(abortMatch[1]!);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(true));
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
        res.write(
          `event: message\ndata: ${JSON.stringify({
            id: 'evt_init',
            type: 'server.connected',
            properties: {},
          })}\n\n`,
        );
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

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const adapter = new OpenCodeAdapter({
      baseUrl,
      password: 'test-secret-password',
      machineId: 'macbook_pro',
    });
    cleanups.push(() => adapter.dispose());

    // 1. detect()
    const info = await adapter.detect();
    expect(info).toEqual({
      id: 'opencode',
      name: 'OpenCode',
      available: true,
      version: '0.15.2',
      capabilities: adapter.capabilities,
    });

    // 2. listSessions()
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([
      {
        id: 'ses_alpha',
        agentId: 'opencode',
        title: 'Implement OpenCode adapter',
        projectPath: '/workspace/nienie',
        status: 'running',
        createdAt: new Date(1762214400000).toISOString(),
        updatedAt: new Date(1762214460000).toISOString(),
      },
      {
        id: 'ses_beta',
        agentId: 'opencode',
        title: 'Fix flaky test',
        projectPath: '/workspace/nienie',
        status: 'idle',
        createdAt: new Date(1762210800000).toISOString(),
        updatedAt: new Date(1762210900000).toISOString(),
      },
    ]);

    // 3. createSession()
    const created = await adapter.createSession({
      title: 'Mobile Bridge Session',
      projectPath: '/workspace/mobile-test',
    });
    expect(created).toEqual({
      id: 'ses_created_1',
      agentId: 'opencode',
      title: 'Mobile Bridge Session',
      projectPath: '/workspace/mobile-test',
      status: 'idle',
      createdAt: new Date(1762215000000).toISOString(),
      updatedAt: new Date(1762215000000).toISOString(),
    });

    // 4. loadSession() - existing & non-existing (must not fake missing session state)
    const loaded = await adapter.loadSession('ses_alpha');
    expect(loaded.id).toBe('ses_alpha');
    expect(loaded.status).toBe('running');
    await expect(adapter.loadSession('ses_non_existent')).rejects.toThrow(/ses_non_existent/);

    // 5. subscribe to SSE events + sendMessage()
    const receivedEvents: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => receivedEvents.push(event));
    await adapter.connectEvents();

    await adapter.sendMessage('ses_alpha', '你好 OpenCode');
    expect(receivedPrompts).toHaveLength(1);
    expect(receivedPrompts[0]).toEqual({
      sessionId: 'ses_alpha',
      body: {
        parts: [{ type: 'text', text: '你好 OpenCode' }],
      },
      auth: `Basic ${Buffer.from('opencode:test-secret-password').toString('base64')}`,
    });

    await waitFor(() => receivedEvents.length >= 3);
    expect(receivedEvents.map((e) => ({ seq: e.sequence, type: e.type, payload: e.payload }))).toEqual([
      { seq: 1, type: 'status', payload: { status: 'running', detail: 'Session is busy' } },
      { seq: 2, type: 'text_delta', payload: { delta: '收到你的消息！' } },
      { seq: 3, type: 'status', payload: { status: 'idle', detail: 'Session is idle' } },
    ]);

    // 6. cancel()
    await adapter.cancel('ses_alpha');
    expect(abortedSessions).toEqual(['ses_alpha']);
  });
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for condition');
}
