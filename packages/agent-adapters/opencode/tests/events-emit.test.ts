import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeAdapter } from '../src/index.js';

/**
 * 事件回流守卫测试。
 *
 * 复刻真实 OpenCode 的事件投递语义：带 `?directory=<dir>` 创建的会话，
 * 其 session/message 事件**只**推给 `GET /event?directory=<dir>` 的订阅者，
 * **不进**全局 `GET /event`。本测试据此锁定：适配器必须按会话 directory
 * 订阅 SSE，否则项目会话的回复会丢失（手机只见用户气泡、无回复）。
 *
 * 谁把 connectEvents 改回只连全局 `/event`，此测试立即变红。
 */

const PROJECT_DIR = '/workspace/proj-alpha';

type Subscriber = { directory: string; res: ServerResponse };

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function waitFor(condition: () => boolean, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for condition');
}

describe('OpenCode 事件回流（目录级 SSE 订阅）', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('带 projectPath 建会话 + 发消息，必须收到 text_delta，且须订阅 /event?directory=<projectPath>', async () => {
    const subscribers: Subscriber[] = [];
    const subscribedEventPaths: string[] = [];
    const sessions = new Map<string, { id: string; directory: string }>();

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // SSE 订阅：按 directory 查询参数分片（复刻 OpenCode 真实行为）
      if (req.method === 'GET' && url.pathname === '/event') {
        const directory = url.searchParams.get('directory') ?? '';
        subscribedEventPaths.push(url.pathname + (directory ? `?directory=${directory}` : ''));
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        subscribers.push({ directory, res });
        req.on('close', () => {
          const idx = subscribers.findIndex((s) => s.res === res);
          if (idx >= 0) subscribers.splice(idx, 1);
        });
        res.write(
          `event: message\ndata: ${JSON.stringify({
            id: 'evt_init',
            type: 'server.connected',
            properties: {},
          })}\n\n`,
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session') {
        const directory = url.searchParams.get('directory') ?? '';
        const body = (await readJsonBody(req)) as { title?: string };
        const id = `ses_${sessions.size + 1}`;
        sessions.set(id, { id, directory });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            directory,
            title: body?.title ?? 'Untitled',
            version: '0.15.2',
            time: { created: Date.now(), updated: Date.now() },
          }),
        );
        return;
      }

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (req.method === 'POST' && promptMatch) {
        const sessionId = promptMatch[1]!;
        await readJsonBody(req);
        res.writeHead(204);
        res.end();

        // 关键：只把事件推给**该会话 directory** 的订阅者，全局订阅者收不到。
        const session = sessions.get(sessionId);
        const targetDir = session?.directory ?? '';
        for (const sub of subscribers) {
          if (sub.directory !== targetDir) continue;
          sub.res.write(
            `event: message\ndata: ${JSON.stringify({
              id: 'evt_status',
              type: 'session.status',
              properties: { sessionID: sessionId, status: { type: 'busy' } },
            })}\n\n`,
          );
          sub.res.write(
            `event: message\ndata: ${JSON.stringify({
              id: 'evt_delta',
              type: 'message.part.delta',
              properties: {
                sessionID: sessionId,
                messageID: 'msg_1',
                partID: 'part_1',
                field: 'text',
                delta: '收到你的消息！',
              },
            })}\n\n`,
          );
          sub.res.write(
            `event: message\ndata: ${JSON.stringify({
              id: 'evt_idle',
              type: 'session.idle',
              properties: { sessionID: sessionId },
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
          for (const sub of subscribers) sub.res.end();
          server.close(() => resolve());
        }),
    );

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const adapter = new OpenCodeAdapter({ baseUrl, machineId: 'macbook_pro' });
    cleanups.push(() => adapter.dispose());

    const events: Array<{ type: string; delta?: string | undefined }> = [];
    adapter.onEvent((e) =>
      events.push({ type: e.type, delta: (e.payload as { delta?: string })?.delta }),
    );

    // 产品路径：带 projectPath 建会话 → 发消息
    const session = await adapter.createSession({ title: 'proj-sess', projectPath: PROJECT_DIR });
    expect(session.projectPath).toBe(PROJECT_DIR);

    await adapter.sendMessage(session.id, '你是什么模型');

    await waitFor(() => events.some((e) => e.type === 'text_delta'));

    // 核心断言 1：必须收到 text_delta 且回复内容正确
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.map((e) => e.delta).join('')).toBe('收到你的消息！');

    // 核心断言 2：适配器必须订阅了目录级事件流（否则上面的 text_delta 不可能出现）
    expect(subscribedEventPaths).toContain(`/event?directory=${PROJECT_DIR}`);
  });

  it('不同 projectPath 的会话各自订阅独立的目录级事件流', async () => {
    const subscribers: Subscriber[] = [];
    const subscribedEventPaths: string[] = [];
    const sessions = new Map<string, { id: string; directory: string }>();

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/event') {
        const directory = url.searchParams.get('directory') ?? '';
        subscribedEventPaths.push(directory);
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
        subscribers.push({ directory, res });
        req.on('close', () => {
          const idx = subscribers.findIndex((s) => s.res === res);
          if (idx >= 0) subscribers.splice(idx, 1);
        });
        res.write(`event: message\ndata: ${JSON.stringify({ id: 'i', type: 'server.connected', properties: {} })}\n\n`);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/session') {
        const directory = url.searchParams.get('directory') ?? '';
        const body = (await readJsonBody(req)) as { title?: string };
        const id = `ses_${sessions.size + 1}`;
        sessions.set(id, { id, directory });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, directory, title: body?.title, time: { created: 1, updated: 1 } }));
        return;
      }
      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (req.method === 'POST' && promptMatch) {
        const sessionId = promptMatch[1]!;
        await readJsonBody(req);
        res.writeHead(204);
        res.end();
        const targetDir = sessions.get(sessionId)?.directory ?? '';
        for (const sub of subscribers) {
          if (sub.directory !== targetDir) continue;
          sub.res.write(
            `event: message\ndata: ${JSON.stringify({
              id: 'd',
              type: 'message.part.delta',
              properties: { sessionID: sessionId, messageID: 'm', partID: 'p', field: 'text', delta: 'ok:' + targetDir },
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
          for (const sub of subscribers) sub.res.end();
          server.close(() => resolve());
        }),
    );

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, machineId: 'mac' });
    cleanups.push(() => adapter.dispose());

    const events: Array<{ delta?: string | undefined; sessionId?: string | undefined }> = [];
    adapter.onEvent((e) =>
      events.push({
        delta: (e.payload as { delta?: string })?.delta,
        sessionId: e.sessionId,
      }),
    );

    const dirA = '/workspace/alpha';
    const dirB = '/workspace/beta';
    const sesA = await adapter.createSession({ title: 'a', projectPath: dirA });
    const sesB = await adapter.createSession({ title: 'b', projectPath: dirB });
    await adapter.sendMessage(sesA.id, 'hi');
    await adapter.sendMessage(sesB.id, 'hi');

    await waitFor(() => events.filter((e) => e.delta?.startsWith('ok:')).length >= 2);

    // 两个目录各自订阅、各自收到各自目录的事件（Map 多连接生效）
    expect(subscribedEventPaths).toContain(dirA);
    expect(subscribedEventPaths).toContain(dirB);
    const deltaA = events.find((e) => e.delta === `ok:${dirA}`);
    const deltaB = events.find((e) => e.delta === `ok:${dirB}`);
    expect(deltaA).toBeTruthy();
    expect(deltaB).toBeTruthy();
    // 事件不得跨会话串扰：A 目录的事件归属 A 会话，B 同理
    expect(deltaA!.sessionId).toBe(sesA.id);
    expect(deltaB!.sessionId).toBe(sesB.id);
  });
});
