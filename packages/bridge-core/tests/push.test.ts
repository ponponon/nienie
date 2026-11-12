import { describe, expect, it } from 'vitest';
import {
  BarkPushSender,
  createPushSender,
  DEFAULT_PUSH_PREFERENCES,
  isWithinQuietHours,
  NtfyPushSender,
  PushNotificationRouter,
  sanitizePushBody,
  WebhookPushSender,
  type PushNotificationMessage,
} from '../src/push.js';
import type { CanonicalAgentEvent } from '@nienie/protocol';

let eventSeq = 0;
function event(over: Partial<CanonicalAgentEvent> & { type: CanonicalAgentEvent['type']; payload: Record<string, unknown> }): CanonicalAgentEvent {
  return {
    version: 1,
    eventId: `evt_${++eventSeq}`,
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
      webhookSender: async (message) => {
        sent.push(message);
      },
      resolveSessionTitle: (id) => (id === 'ses_1' ? '修 GC Bug' : undefined),
      preferences: { ...(prefs ?? {}) },
    });
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

  it('R2/R6：webhook 全局单目标每事件一次，无注册也发送；设备级按注册逐设备且同 token 去重', async () => {
    const sent: PushNotificationMessage[] = [];
    const deviceSent: PushNotificationMessage[] = [];
    const router = new PushNotificationRouter({
      webhookSender: async (message) => {
        sent.push(message);
      },
      deviceSender: async (message) => {
        deviceSent.push(message);
      },
      resolveSessionTitle: () => '修 GC Bug',
    });
    // 无任何注册：webhook 仍发送（R2）
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.clickUrl).toBe('nienie://session/ses_1');
    // 3 个设备注册（2 个同 token）：webhook 仍只一次；设备级 2 次
    router.registerDevice(registration('dev_2', 'tok_a'));
    router.registerDevice(registration('dev_3', 'tok_a'));
    router.registerDevice(registration('dev_4', 'tok_b'));
    await router.notifyEvent(event({ type: 'status', payload: { status: 'waiting', detail: '审批' } }), { now });
    expect(sent).toHaveLength(2);
    expect(deviceSent).toHaveLength(2);
  });

  it('R4：投递异常被吞掉不外抛，经 onDeliveryError 上报（终态失败）', async () => {
    const errors: unknown[] = [];
    const router = new PushNotificationRouter({
      webhookSender: async () => {
        throw new Error('hook 500');
      },
      retryDelaysMs: [],
      onDeliveryError: (error) => errors.push(error),
    });
    await expect(
      router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('事件级去重：同 eventId 重复投递只推一次', async () => {
    const sent: PushNotificationMessage[] = [];
    const router = makeRouter(sent);
    const same = event({ type: 'status', payload: { status: 'idle' } });
    await router.notifyEvent(same, { now });
    await router.notifyEvent(same, { now });
    expect(sent).toHaveLength(1);
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

describe('三类 Sender 真实 HTTP（R5/R9）', () => {
  it('Bark JSON 带 url 深链；ntfy Topic 模式正文纯文本 + Title RFC2047 + Click/Actions（actions 中文经 latin1 字节通道还原）', async () => {
    const { createServer } = await import('node:http');
    const got: Array<{ path: string; headers: Record<string, unknown>; body: string }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        got.push({ path: req.url ?? '', headers: req.headers, body: raw });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const message = {
      deviceId: 'd', platform: 'unknown' as const, provider: 'webhook' as const, pushToken: 't',
      sessionId: 'ses_1', title: 'Nienie · 任务完成', body: '修 GC Bug：已完成。',
      clickUrl: 'nienie://session/ses_1', timestamp: 1,
    };
    try {
      await createPushSender({ type: 'bark', url: `${base}/key` }).send(message);
      await createPushSender({ type: 'ntfy', url: `${base}/mytopic` }).send(message);
      await new Promise((r) => setTimeout(r, 200));
      const bark = got.find((g) => g.path === '/key')!;
      const barkBody = JSON.parse(bark.body) as { title: string; url: string };
      expect(barkBody.title).toBe('Nienie · 任务完成');
      expect(barkBody.url).toBe('nienie://session/ses_1');

      const ntfy = got.find((g) => g.path === '/mytopic')!;
      expect(ntfy.body).toBe('修 GC Bug：已完成。'); // Topic 模式正文是纯文本不是 JSON
      const rawTitle = String(ntfy.headers['title']);
      expect(rawTitle.startsWith('=?UTF-8?B?')).toBe(true); // RFC2047 ASCII 头
      const decodedTitle = Buffer.from(rawTitle.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8');
      expect(decodedTitle).toBe('Nienie · 任务完成');
      expect(ntfy.headers['click']).toBe('nienie://session/ses_1');
      const actions = JSON.parse(Buffer.from(String(ntfy.headers['actions']), 'latin1').toString('utf8')) as Array<{ label: string }>;
      expect(actions[0]!.label).toBe('打开会话');
    } finally {
      server.close();
    }
  });

  it('createPushSender 自动识别：day.app→Bark、含 ntfy 主机→ntfy、其余→webhook；非法 URL 拒绝', () => {
    expect(createPushSender({ type: 'auto', url: 'https://api.day.app/abc' })).toBeInstanceOf(BarkPushSender);
    expect(createPushSender({ type: 'auto', url: 'https://ntfy.sh/topic' })).toBeInstanceOf(NtfyPushSender);
    expect(createPushSender({ type: 'auto', url: 'https://hook.example/x' })).toBeInstanceOf(WebhookPushSender);
    expect(() => createPushSender({ type: 'auto', url: 'file:///etc/passwd' })).toThrow(/Invalid/);
    expect(() => createPushSender({ type: 'auto', url: 'https://user:pass@host/x' })).toThrow(/Invalid/);
    expect(() => createPushSender({ type: 'ntfy', url: 'https://ntfy.sh/' })).toThrow(/topic/);
  });
});

describe('R3 第三轮：可靠性与脱敏', () => {
  const now = new Date('2026-11-11T12:00:00');
  it('sanitizePushBody 默认模式折叠 macOS/Linux/Windows/UNC 路径为 ~/或…/ + 文件名', () => {
    const detailed = false;
    expect(sanitizePushBody('cat /Users/alice/Company/private-project/src/main.ts', detailed))
      .toBe('cat ~/main.ts');
    expect(sanitizePushBody('cat /home/bob/work/repo/a.py', detailed)).toBe('cat ~/a.py');
    expect(sanitizePushBody('type C:\\Users\\bob\\Secret\\app\\main.py', detailed)).toBe('type ~/main.py');
    expect(sanitizePushBody('open /etc/ssh/config', detailed)).toBe('open …/config');
    // 详细模式保留原样
    expect(sanitizePushBody('cat /Users/alice/Company/x.ts', true)).toContain('/Users/alice/Company/x.ts');
  });

  it('后台延迟重试队列：短暂故障后自动恢复；成功才 delivered；期间同事件不重复', async () => {
    const sent: PushNotificationMessage[] = [];
    let failures = 2;
    const scheduled: Array<() => void> = [];
    const router = new PushNotificationRouter({
      webhookSender: async (message) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('hook 503');
        }
        sent.push(message);
      },
      retryDelaysMs: [1, 2],
      scheduleRetry: (fn) => {
        scheduled.push(fn);
      },
    });
    const same = event({ type: 'status', payload: { status: 'idle' } });
    await router.notifyEvent(same, { now }); // 首次失败 → 排入重试
    expect(sent).toHaveLength(0);
    await router.notifyEvent(same, { now }); // inFlight：不重复派发
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!(); // 第 1 次重试仍失败 → 再排队
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);
    scheduled.shift()!(); // 第 2 次重试成功
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    await router.notifyEvent(same, { now }); // delivered → 去重
    expect(sent).toHaveLength(1);
  });

  it('重试超限终态失败：onDeliveryError 记录并释放 inFlight 允许后续重触发', async () => {
    const errors: unknown[] = [];
    let sends = 0;
    const router = new PushNotificationRouter({
      webhookSender: async () => {
        sends += 1;
        throw new Error('hook down');
      },
      retryDelaysMs: [1],
      onDeliveryError: (error) => errors.push(error),
    });
    const same = event({ type: 'status', payload: { status: 'idle' } });
    await router.notifyEvent(same, { now });
    await new Promise((r) => setTimeout(r, 5)); // 等重试执行完（重试 1 次后终态）
    expect(sends).toBe(2); // 首次 + 1 次重试
    expect(errors).toHaveLength(1);
    // inFlight 释放后，同一事件再次到达允许重新触发
    await router.notifyEvent(same, { now });
    await new Promise((r) => setTimeout(r, 5));
    expect(sends).toBe(4);
  });

  it('并发相同事件只派发一次（in-flight 去重）', async () => {
    const sent: PushNotificationMessage[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const router = new PushNotificationRouter({
      webhookSender: async (message) => {
        await gate;
        sent.push(message);
      },
    });
    const same = event({ type: 'status', payload: { status: 'idle' } });
    const a = router.notifyEvent(same, { now });
    const b = router.notifyEvent(same, { now });
    release();
    await Promise.all([a, b]);
    expect(sent).toHaveLength(1);
  });

  it('空配置 webhookSender 抛错时按失败处理，绝不静默记 delivered', async () => {
    const errors: unknown[] = [];
    const router = new PushNotificationRouter({
      webhookSender: async () => {
        throw new Error('notification webhook not configured');
      },
      retryDelaysMs: [],
      onDeliveryError: (error) => errors.push(error),
    });
    const same = event({ type: 'status', payload: { status: 'idle' } });
    await router.notifyEvent(same, { now });
    expect(errors).toHaveLength(1);
    await router.notifyEvent(same, { now }); // 未 delivered → 允许重触发
    expect(errors).toHaveLength(2);
  });

  it('完成通知带真实摘要；无摘要时降级为普通完成通知', async () => {
    const sent: PushNotificationMessage[] = [];
    const router = new PushNotificationRouter({ webhookSender: async (m) => {
      sent.push(m);
    } });
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), {
      now,
      sessionTitle: '修 GC Bug',
      summary: '已完成：28 项测试通过',
    });
    expect(sent[0]!.body).toBe('修 GC Bug：已完成：28 项测试通过');
    await router.notifyEvent(event({ type: 'status', payload: { status: 'idle' } }), { now, sessionTitle: '修 GC Bug' });
    expect(sent[1]!.body).toBe('修 GC Bug：Agent 已完成本轮任务。');
  });

  it('auto 识别域名收紧：非官方域名不误判为 Bark/ntfy', () => {
    expect(createPushSender({ type: 'auto', url: 'https://my-bark.example.com/key' })).toBeInstanceOf(WebhookPushSender);
    expect(createPushSender({ type: 'auto', url: 'https://api.day.app/k' })).toBeInstanceOf(BarkPushSender);
    expect(createPushSender({ type: 'auto', url: 'https://ntfy.example.com/t' })).toBeInstanceOf(NtfyPushSender);
  });
});
