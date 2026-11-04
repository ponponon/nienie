import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodePairingQrPayload,
  DesktopBridgeController,
  type BridgeResponse,
  type CanonicalAgentEvent,
} from '../src/bridge.js';

describe('E2E loop: Mobile -> Desktop Bridge -> OpenCode -> Canonical Events -> Mobile', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('completes pairing, reconnection, agent discovery, prompt execution, tool pairing, text completion, and restart verification', async () => {
    const sseClients = new Set<ServerResponse>();
    const sessionsStore = new Map<
      string,
      { id: string; directory: string; title: string; time: { created: number; updated: number } }
    >();
    const promptsReceived: Array<{ sessionId: string; text: string }> = [];

    // 1. Start OpenCode HTTP + SSE server
    const opencodeServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/global/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, version: '0.15.2' }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([...sessionsStore.values()]));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/session/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session') {
        const body = (await readJson(req)) as { title?: string };
        const created = {
          id: `ses_${sessionsStore.size + 1}`,
          directory: url.searchParams.get('directory') ?? '/workspace/nienie',
          title: body.title ?? 'Untitled',
          time: { created: 1762220000000, updated: 1762220000000 },
        };
        sessionsStore.set(created.id, created);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(created));
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/session/')) {
        const sessionId = decodeURIComponent(url.pathname.slice('/session/'.length));
        const found = sessionsStore.get(sessionId);
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
        const body = (await readJson(req)) as { parts?: Array<{ text?: string }> };
        promptsReceived.push({
          sessionId,
          text: body.parts?.[0]?.text ?? '',
        });
        res.writeHead(204);
        res.end();

        // Emit structured OpenCode SSE stream: busy -> tool running -> tool completed -> text deltas -> idle
        const sseFrames = [
          {
            id: 'oc_1',
            type: 'session.status',
            properties: { sessionID: sessionId, status: { type: 'busy' } },
          },
          {
            id: 'oc_2',
            type: 'message.part.updated',
            properties: {
              sessionID: sessionId,
              part: {
                id: 'part_tool_1',
                sessionID: sessionId,
                messageID: 'msg_asst_1',
                type: 'tool',
                callID: 'call_test_1',
                tool: 'bash',
                state: {
                  status: 'running',
                  input: { command: 'pnpm test' },
                  time: { start: 1 },
                },
              },
            },
          },
          {
            id: 'oc_3',
            type: 'message.part.updated',
            properties: {
              sessionID: sessionId,
              part: {
                id: 'part_tool_1',
                sessionID: sessionId,
                messageID: 'msg_asst_1',
                type: 'tool',
                callID: 'call_test_1',
                tool: 'bash',
                state: {
                  status: 'completed',
                  input: { command: 'pnpm test' },
                  output: 'All tests green',
                  title: 'Run tests',
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
            },
          },
          {
            id: 'oc_4',
            type: 'message.part.delta',
            properties: {
              sessionID: sessionId,
              messageID: 'msg_asst_1',
              partID: 'part_text_1',
              field: 'text',
              delta: '测试已全部通过，',
            },
          },
          {
            id: 'oc_5',
            type: 'message.part.delta',
            properties: {
              sessionID: sessionId,
              messageID: 'msg_asst_1',
              partID: 'part_text_1',
              field: 'text',
              delta: '闭环验证成功。',
            },
          },
          {
            id: 'oc_6',
            type: 'session.idle',
            properties: { sessionID: sessionId },
          },
        ];

        for (const client of sseClients) {
          for (const frame of sseFrames) {
            client.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
          }
        }
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

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => opencodeServer.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of sseClients) client.end();
          opencodeServer.close(() => resolve());
        }),
    );

    const ocAddr = opencodeServer.address();
    if (!ocAddr || typeof ocAddr === 'string') throw new Error('Expected OpenCode TCP address');
    const opencodeBaseUrl = `http://127.0.0.1:${ocAddr.port}`;

    // 2. Start Electron Desktop Bridge Controller
    const desktop = new DesktopBridgeController({
      machineId: 'macbook_e2e',
      opencode: { baseUrl: opencodeBaseUrl, machineId: 'macbook_e2e' },
      codex: { detectVersion: async () => 'codex-cli 0.166.0' },
    });
    cleanups.push(() => desktop.dispose());

    const desktopState = await desktop.startBridge();
    expect(desktopState.bridge.status).toBe('running');
    expect(desktopState.agents.find((a) => a.id === 'opencode')?.available).toBe(true);
    expect(desktopState.pairing).not.toBeNull();

    // 3. Mobile scans QR URI and verifies unauthorized requests are blocked before pairing
    const qrPayload = decodePairingQrPayload(desktopState.pairing!.qrUri);
    const initialMobile = await connectMobileWs(qrPayload.wsUrl);
    cleanups.push(async () => initialMobile.close());

    const unauthPrompt = await initialMobile.request({
      type: 'session.send',
      requestId: 'req_unauth',
      sessionId: 'ses_1',
      message: 'should fail',
    });
    expect(unauthPrompt).toMatchObject({
      type: 'response',
      requestId: 'req_unauth',
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });

    // 4. Mobile completes one-time pairing
    const pairResponse = await initialMobile.request({
      type: 'pair.confirm',
      requestId: 'req_pair',
      pairingCode: qrPayload.pairingCode,
      deviceName: 'Flutter iPhone',
      platform: 'ios',
    });
    expect(pairResponse).toMatchObject({
      type: 'response',
      requestId: 'req_pair',
      ok: true,
    });
    const deviceToken = (pairResponse as { data: { deviceToken: string } }).data.deviceToken;

    // 5. Simulate mobile WebSocket disconnect and reconnect using saved deviceToken
    initialMobile.close();
    const mobile = await connectMobileWs(qrPayload.wsUrl);
    cleanups.push(async () => mobile.close());

    const helloRes = await mobile.request({
      type: 'hello',
      requestId: 'req_hello_reconnect',
      protocolVersion: 1,
      deviceToken,
    });
    expect(helloRes).toMatchObject({
      type: 'response',
      requestId: 'req_hello_reconnect',
      ok: true,
      data: { authenticated: true, machineId: 'macbook_e2e' },
    });

    // 6. Mobile creates a session and sends a prompt
    const createRes = await mobile.request({
      type: 'session.create',
      requestId: 'req_create_ses',
      agentId: 'opencode',
      input: { title: 'E2E Mobile Task', projectPath: '/workspace/nienie' },
    });
    const sessionId = (createRes as { data: { session: { id: string } } }).data.session.id;

    const sendRes = await mobile.request({
      type: 'session.send',
      requestId: 'req_send_prompt',
      sessionId,
      message: '运行测试并汇报结果',
    });
    expect(sendRes).toMatchObject({
      type: 'response',
      requestId: 'req_send_prompt',
      ok: true,
      data: { accepted: true, sessionId },
    });
    expect(promptsReceived).toEqual([{ sessionId, text: '运行测试并汇报结果' }]);

    // 7. Mobile receives normalized canonical events in order
    await mobile.waitForEvents(6);
    expect(mobile.events.map((e) => ({ seq: e.sequence, type: e.type, payload: e.payload }))).toEqual([
      {
        seq: 1,
        type: 'status',
        payload: { status: 'running', detail: 'Session is busy' },
      },
      {
        seq: 2,
        type: 'tool_use',
        payload: {
          toolCallId: 'call_test_1',
          name: 'bash',
          input: { command: 'pnpm test' },
        },
      },
      {
        seq: 3,
        type: 'tool_result',
        payload: {
          toolCallId: 'call_test_1',
          content: 'All tests green',
          isError: false,
        },
      },
      {
        seq: 4,
        type: 'text_delta',
        payload: { delta: '测试已全部通过，' },
      },
      {
        seq: 5,
        type: 'text_delta',
        payload: { delta: '闭环验证成功。' },
      },
      {
        seq: 6,
        type: 'status',
        payload: { status: 'idle', detail: 'Session is idle' },
      },
    ]);

    // 8. Verify Bridge restart does not fake non-existent old session state
    await desktop.stopBridge();
    const restartedState = await desktop.startBridge();
    const postRestartChallenge = desktop.refreshPairingCode();
    const mobileAfterRestart = await connectMobileWs(restartedState.bridge.wsUrl!);
    cleanups.push(async () => mobileAfterRestart.close());

    await mobileAfterRestart.request({
      type: 'pair.confirm',
      requestId: 'req_pair_2',
      pairingCode: postRestartChallenge.pairing!.pairingCode,
      deviceName: 'Flutter iPhone',
    });

    // Clear OpenCode sessions to simulate a session that no longer exists after restart
    sessionsStore.clear();

    const loadMissingRes = await mobileAfterRestart.request({
      type: 'session.load',
      requestId: 'req_load_missing',
      agentId: 'opencode',
      sessionId: 'ses_vanished_after_restart',
    });
    expect(loadMissingRes).toMatchObject({
      type: 'response',
      requestId: 'req_load_missing',
      ok: false,
      error: {
        code: 'COMMAND_EXECUTION_FAILED',
      },
    });
  });
});

async function connectMobileWs(url: string) {
  const ws = new WebSocket(url);
  const pending = new Map<string, (res: BridgeResponse) => void>();
  const events: CanonicalAgentEvent[] = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data)) as BridgeResponse;
    if (msg.type === 'response') {
      const resolver = pending.get(msg.requestId);
      if (resolver) {
        pending.delete(msg.requestId);
        resolver(msg);
      }
    } else if (msg.type === 'session.event') {
      events.push(msg.event);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (err) => reject(err), { once: true });
  });

  return {
    events,
    request(payload: Record<string, unknown>): Promise<BridgeResponse> {
      const requestId = String(payload.requestId);
      return new Promise<BridgeResponse>((resolve) => {
        pending.set(requestId, resolve);
        ws.send(JSON.stringify(payload));
      });
    },
    async waitForEvents(count: number, timeoutMs = 2000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (events.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (events.length < count) {
        throw new Error(`Expected ${count} events, received ${events.length}`);
      }
    },
    close() {
      ws.close();
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
