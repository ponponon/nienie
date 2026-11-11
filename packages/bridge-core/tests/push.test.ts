import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_PREFERENCES,
  isWithinQuietHours,
  PushNotificationRouter,
  WebhookPushSender,
  type PushNotificationMessage,
} from '../src/push.js';
import type { CanonicalAgentEvent } from '@nienie/protocol';

function event(over: Partial<CanonicalAgentEvent> & { type: CanonicalAgentEvent['type']; payload: Record<string, unknown> }): CanonicalAgentEvent {
  return {
    version: 1,
    eventId: 'evt_1',
    streamEpoch: 'ep1',
    sessionId: 'ses_1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    machineId: 'm1',
    agentId: 'opencode',
    ...over,
  } as CanonicalAgentEvent;
}

function registration(deviceId = 'dev_1', pushToken = 'https://hook.example/abc') {
  return { deviceId, platform: 'android' as const, provider: 'webhook' as const, pushToken };
}

describe('WebhookPushSender', () => {
  it('POST JSON 带 Title header，非 2xx 抛错', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const okFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch;
    const sender = new WebhookPushSender({ url: 'https://hook.example/abc', fetch: okFetch });
    await sender.send({
      deviceId: 'dev_1',
      platform: 'android',
      provider: 'webhook',
      pushToken: 'https://hook.example/abc',
      sessionId: 'ses_1',
      title: 'T',
      body: 'B',
      timestamp: 123,
    });
    expect(calls[0]!.url).toBe('https://hook.example/abc');
    expect(calls[0]!.headers['title']).toBe('T');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toMatchObject({ title: 'T', body: 'B', sessionId: 'ses_1', timestamp: 123 });

    const failFetch = (async () => new Response('no', { status: 500 })) as typeof globalThis.fetch;
    await expect(
      new WebhookPushSender({ url: 'https://hook.example/abc', fetch: failFetch }).send({
        deviceId: 'd', platform: 'android', provider: 'webhook', pushToken: 't', sessionId: 's', title: 'T', body: 'B', timestamp: 1,
      }),
    ).rejects.toThrow(/500/);
  });
});

describe('PushNotificationRouter（路线图 1.2-1.5）', () => {
  const now = new Date('2026-11-11T12:00:00');

  function makeRouter(sent: PushNotificationMessage[], prefs?: Parameters<PushNotificationRouter['setPreferences']>[0]) {
    const router = new PushNotificationRouter({
      sender: async (message) => {
        sent.push(message);
      },
      resolveSessionTitle: (id) => (id === 'ses_1' ? '修 GC Bug' : undefined),
      preferences: { ...(prefs ?? {}) },
    });
    router.registerDevice(registration());
    return router;
  }

  it('1.2 完成通知（idle）带会话标题', async () => {
    const sent: PushNotificationMessage[] = [];
    const router = makeRouter(sent);
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('完成');
    expect(sent[0]!.body).toContain('修 GC Bug');
  });

  it('1.3 等待审批 + 1.4 出错通知', async () => {
    const sent: PushNotificationMessage[] = [];
    const router = makeRouter(sent);
    await router.notifyEvent(event({ type: 'status', payload: { status: 'waiting', detail: '执行 rm -rf' } }), { now });
    await router.notifyEvent(event({ type: 'error', payload: { message: 'exit code 1' } }), { now });
    expect(sent.map((m) => m.title)).toEqual([expect.stringContaining('批准'), expect.stringContaining('出错')]);
    expect(sent[0]!.body).toContain('执行 rm -rf');
    expect(sent[1]!.body).toContain('exit code 1');
  });

  it('1.5 偏好：全局开关 / 会话静音 / 免打扰时段', async () => {
    const sent: PushNotificationMessage[] = [];
    const router = makeRouter(sent);
    router.setPreferences({ enabled: false });
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now });
    expect(sent).toHaveLength(0);

    router.setPreferences({ enabled: true, mutedSessionIds: ['ses_1'] });
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now });
    expect(sent).toHaveLength(0);

    router.setPreferences({ mutedSessionIds: [], quietHours: { start: '22:00', end: '08:00' } });
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now: new Date('2026-11-11T23:00:00') });
    expect(sent).toHaveLength(0); // 免打扰
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now: new Date('2026-11-11T07:00:00') });
    expect(sent).toHaveLength(0); // 跨午夜仍免打扰
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now: new Date('2026-11-11T12:00:00') });
    expect(sent).toHaveLength(1); // 时段外正常
    expect(router.getPreferences().quietHours).toEqual({ start: '22:00', end: '08:00' });
    expect(DEFAULT_PUSH_PREFERENCES.enabled).toBe(true);
  });

  it('多设备同 pushToken 去重只投一份', async () => {
    const sent: PushNotificationMessage[] = [];
    const router = makeRouter(sent);
    router.registerDevice(registration('dev_2', 'https://hook.example/abc'));
    router.registerDevice(registration('dev_3', 'https://hook.example/other'));
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now });
    expect(sent).toHaveLength(2);
  });

  it('isWithinQuietHours 边界：start 含 end 不含', () => {
    const quiet = { start: '22:00', end: '08:00' };
    expect(isWithinQuietHours(quiet, new Date('2026-11-11T22:00:00'))).toBe(true);
    expect(isWithinQuietHours(quiet, new Date('2026-11-11T08:00:00'))).toBe(false);
    expect(isWithinQuietHours(quiet, new Date('2026-11-11T12:00:00'))).toBe(false);
    expect(isWithinQuietHours({ start: '09:00', end: '18:00' }, new Date('2026-11-11T17:59:00'))).toBe(true);
    expect(isWithinQuietHours({ start: '09:00', end: '18:00' }, new Date('2026-11-11T18:00:00'))).toBe(false);
    expect(isWithinQuietHours({ start: 'ab', end: 'cd' }, new Date())).toBe(false);
  });
});

describe('WebhookPushSender 真实 HTTP（Node/undici 运行时 = Electron 生产语义）', () => {
  it('中文标题经 latin1 字节通道后接收端可按 UTF-8 还原，body JSON 保持正确', async () => {
    const { createServer } = await import('node:http');
    const received: Array<{ title: string | undefined; body: string }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        received.push({ title: req.headers['title'] as string | undefined, body: raw });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const sender = new WebhookPushSender({ url: `http://127.0.0.1:${port}/push` });
      await sender.send({
        deviceId: 'dev_1',
        platform: 'android',
        provider: 'webhook',
        pushToken: `http://127.0.0.1:${port}/push`,
        sessionId: 'ses_1',
        title: 'Nienie · 任务完成',
        body: '修 GC Bug：Agent 已完成。',
        timestamp: 1,
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(received).toHaveLength(1);
      // 接收端（如 ntfy）把 header 字节按 UTF-8 解码 → 标题还原
      expect(Buffer.from(received[0]!.title ?? '', 'latin1').toString('utf8')).toBe('Nienie · 任务完成');
      const parsed = JSON.parse(received[0]!.body) as { title: string; body: string };
      expect(parsed.title).toBe('Nienie · 任务完成');
      expect(parsed.body).toBe('修 GC Bug：Agent 已完成。');
    } finally {
      server.close();
    }
  });
});
