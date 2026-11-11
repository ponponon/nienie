import { redactLogText } from '@nienie/agent-events';
import type {
  CanonicalAgentEvent,
  DevicePlatform,
  PushProvider,
} from '@nienie/protocol';

export type PushRegistration = {
  deviceId: string;
  platform: DevicePlatform;
  provider: PushProvider;
  pushToken: string;
};

export type PushNotificationMessage = {
  deviceId: string;
  platform: DevicePlatform;
  provider: PushProvider;
  pushToken: string;
  sessionId: string;
  title: string;
  body: string;
};

export type PushNotificationPreferences = {
  /** 全局开关：关闭后所有推送静默（注册保留）。 */
  enabled: boolean;
  /** 免打扰时段（本地时间 HH:mm，start 含 end 不含，支持跨午夜；空表示不启用）。 */
  quietHours?: { start: string; end: string } | undefined;
  /** 静音的会话 ID 列表：这些会话的事件不推送。 */
  mutedSessionIds: string[];
};

export const DEFAULT_PUSH_PREFERENCES: PushNotificationPreferences = {
  enabled: true,
  quietHours: undefined,
  mutedSessionIds: [],
};

/** webhook 推送发送器（路线图 1.1）：POST JSON 到用户配置的 URL（自建服务 / Bark / 网关均适用）。 */
export class WebhookPushSender {
  private readonly url: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    url: string;
    fetch?: typeof globalThis.fetch | undefined;
    timeoutMs?: number | undefined;
  }) {
    this.url = options.url;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async send(message: PushNotificationMessage & { timestamp: number }): Promise<void> {
    const response = await this.doFetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // ntfy 兼容：标题放自定义 header。fetch 要求 header 为 latin1 字符串，
        // 中文等 UTF-8 标题按字节转 latin1 传递（接收端按 UTF-8 解码即还原）。
        title: Buffer.from(message.title, 'utf8').toString('latin1'),
      },
      body: JSON.stringify({
        title: message.title,
        body: message.body,
        sessionId: message.sessionId,
        deviceId: message.deviceId,
        platform: message.platform,
        timestamp: message.timestamp,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`Webhook push failed: ${response.status}`);
    }
  }
}

export type PushNotificationRouterOptions = {
  sender?: ((notification: PushNotificationMessage) => Promise<void>) | undefined;
  /** 会话标题解析（通知正文更有信息量）。 */
  resolveSessionTitle?: ((sessionId: string) => string | undefined) | undefined;
  preferences?: Partial<PushNotificationPreferences> | undefined;
};

function parseHm(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined;
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/** 免打扰判定：start 含 end 不含，支持跨午夜（如 22:00→08:00）。 */
export function isWithinQuietHours(
  quiet: { start: string; end: string },
  now: Date,
): boolean {
  const start = parseHm(quiet.start);
  const end = parseHm(quiet.end);
  if (start === undefined || end === undefined || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export class PushNotificationRouter {
  private readonly registrations = new Map<string, PushRegistration>();
  private readonly sender: (notification: PushNotificationMessage) => Promise<void>;
  private readonly resolveSessionTitle: ((sessionId: string) => string | undefined) | undefined;
  private preferences: PushNotificationPreferences = { ...DEFAULT_PUSH_PREFERENCES };

  constructor(options: PushNotificationRouterOptions = {}) {
    this.sender = options.sender ?? (async () => {});
    this.resolveSessionTitle = options.resolveSessionTitle;
    if (options.preferences) {
      this.preferences = { ...this.preferences, ...options.preferences };
    }
  }

  registerDevice(registration: PushRegistration): void {
    this.registrations.set(registration.deviceId, registration);
  }

  unregisterDevice(deviceId: string): void {
    this.registrations.delete(deviceId);
  }

  setPreferences(preferences: Partial<PushNotificationPreferences>): void {
    this.preferences = {
      ...this.preferences,
      ...preferences,
      mutedSessionIds: preferences.mutedSessionIds
        ? [...preferences.mutedSessionIds]
        : this.preferences.mutedSessionIds,
    };
  }

  getPreferences(): PushNotificationPreferences {
    return {
      ...this.preferences,
      mutedSessionIds: [...this.preferences.mutedSessionIds],
    };
  }

  /** 设置页「发送测试通知」按钮。 */
  async notifyTest(): Promise<void> {
    await this.deliver('Nienie 测试通知', '通知链路正常：你可以在手机上收到推送了。', 'test-session');
  }

  async notifyEvent(
    event: CanonicalAgentEvent,
    context: { sessionTitle?: string | undefined; now?: Date } = {},
  ): Promise<void> {
    if (this.registrations.size === 0) return;
    if (!this.shouldDeliver(event.sessionId, context.now ?? new Date())) return;

    let title: string | undefined;
    let rawBody: string | undefined;

    const sessionLabel =
      context.sessionTitle ?? this.resolveSessionTitle?.(event.sessionId) ?? event.sessionId;

    if (event.type === 'status' && event.payload.status === 'waiting') {
      title = 'Nienie · 等待你的批准';
      rawBody =
        typeof event.payload.detail === 'string'
          ? `${sessionLabel}：${event.payload.detail}`
          : `${sessionLabel}：Agent 正在等待审批`;
    } else if (event.type === 'status' && event.payload.status === 'idle') {
      title = 'Nienie · 任务完成';
      rawBody = `${sessionLabel}：Agent 已完成本轮任务，去看看做了什么。`;
    } else if (event.type === 'error') {
      title = 'Nienie · 执行出错';
      rawBody =
        typeof event.payload.message === 'string'
          ? `${sessionLabel}：${event.payload.message}`
          : `${sessionLabel}：Agent 执行失败`;
    }

    if (!title || !rawBody) return;

    const sanitizedBody = redactLogText(rawBody);
    await this.deliver(title, sanitizedBody, event.sessionId);
  }

  private shouldDeliver(sessionId: string, now: Date): boolean {
    if (!this.preferences.enabled) return false;
    if (this.preferences.mutedSessionIds.includes(sessionId)) return false;
    if (this.preferences.quietHours && isWithinQuietHours(this.preferences.quietHours, now)) {
      return false;
    }
    return true;
  }

  private async deliver(title: string, body: string, sessionId: string): Promise<void> {
    // 按 pushToken 去重：webhook 型通道多设备注册只投递一份，避免重复推送
    const seen = new Set<string>();
    const targets = [...this.registrations.values()].filter((reg) => {
      const key = `${reg.provider}:${reg.pushToken}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await Promise.all(
      targets.map((reg) =>
        this.sender({
          deviceId: reg.deviceId,
          platform: reg.platform,
          provider: reg.provider,
          pushToken: reg.pushToken,
          sessionId,
          title,
          body,
        }),
      ),
    );
  }
}
