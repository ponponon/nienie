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
  /** 通知点击深链：nienie://session/<id>，点击直达对应会话（R9）。 */
  clickUrl?: string | undefined;
};

export type PushNotificationPreferences = {
  enabled: boolean;
  quietHours?: { start: string; end: string } | undefined;
  mutedSessionIds: string[];
  /** 详细通知内容（默认关）：关闭时绝对路径/家目录脱敏，不外发完整本地执行上下文（R8）。 */
  detailed: boolean;
};

export const DEFAULT_PUSH_PREFERENCES: PushNotificationPreferences = {
  enabled: true,
  quietHours: undefined,
  mutedSessionIds: [],
  detailed: false,
};

/** Webhook URL 校验（R8）：仅 http/https、禁止 URL 内嵌凭据。 */
export function validateWebhookUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  return url.toString().replace(/\/+$/, '');
}

/** 外发隐私脱敏（R8）：密钥类走 redactLogText；详细模式关闭时进一步脱敏本机路径/家目录。 */
export function sanitizePushBody(text: string, detailed: boolean): string {
  const secrets = redactLogText(text);
  if (detailed) return secrets;
  return secrets
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(/\/(?:private\/)?var\/folders\/\S+/g, '…')
    .replace(/(?<![\w~])\/(?:[\w.-]+\/)+([\w.-]+)/g, '…/$1');
}

function encodeHeaderUtf8(value: string): string {
  // RFC 2047：标题完全 ASCII，ntfy/Bark 等按标准解码，规避 fetch 头值 latin1 限制
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function safeTitleHeader(value: string): string {
  // latin1 字节通道（非 ASCII 原始字节）；ASCII 直接原样
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : Buffer.from(value, 'utf8').toString('latin1');
}

export type PushSender = (message: PushNotificationMessage & { timestamp: number }) => Promise<void>;

/** 通用 Webhook：POST JSON（自建服务契约）。 */
export class WebhookPushSender {
  private readonly url: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: { url: string; fetch?: typeof globalThis.fetch | undefined; timeoutMs?: number | undefined }) {
    const validated = validateWebhookUrl(options.url);
    if (!validated) throw new Error('Invalid webhook URL');
    this.url = validated;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  send: PushSender = async (message) => {
    const response = await this.doFetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', title: safeTitleHeader(message.title) },
      body: JSON.stringify({
        title: message.title,
        body: message.body,
        sessionId: message.sessionId,
        deviceId: message.deviceId,
        platform: message.platform,
        timestamp: message.timestamp,
        ...(message.clickUrl ? { clickUrl: message.clickUrl } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Webhook push failed: ${response.status}`);
  };
}

/** Bark：POST JSON {title, body, url(click)}（R5/R9）。 */
export class BarkPushSender {
  private readonly url: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: { url: string; fetch?: typeof globalThis.fetch | undefined; timeoutMs?: number | undefined }) {
    const validated = validateWebhookUrl(options.url);
    if (!validated) throw new Error('Invalid Bark URL');
    this.url = validated;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  send: PushSender = async (message) => {
    const response = await this.doFetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: message.title,
        body: message.body,
        group: 'nienie',
        ...(message.clickUrl ? { url: message.clickUrl } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Bark push failed: ${response.status}`);
  };
}

/** ntfy：Topic URL 模式（POST 正文文本 + Title/Click/Actions header），RFC 2047 编码标题（R5/R9）。 */
export class NtfyPushSender {
  private readonly url: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: { url: string; fetch?: typeof globalThis.fetch | undefined; timeoutMs?: number | undefined }) {
    const validated = validateWebhookUrl(options.url);
    if (!validated) throw new Error('Invalid ntfy URL');
    const parsed = new URL(validated);
    const topic = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (!topic) throw new Error('ntfy URL must be a topic URL (e.g. https://ntfy.sh/mytopic)');
    this.url = validated;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  send: PushSender = async (message) => {
    const headers: Record<string, string> = {
      title: encodeHeaderUtf8(message.title),
      // RFC 2047 编码正文，保证多行/中文正文在 header-only 协议下的可读性由 body 承载
      tags: 'robot',
    };
    if (message.clickUrl) {
      headers['click'] = message.clickUrl;
      headers['actions'] = safeTitleHeader(
        JSON.stringify([
          { action: 'view', label: '打开会话', url: message.clickUrl, clear: true },
        ]),
      );
    }
    const response = await this.doFetch(this.url, {
      method: 'POST',
      headers,
      body: message.body,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`ntfy push failed: ${response.status}`);
  };
}

export type PushSenderType = 'auto' | 'bark' | 'ntfy' | 'webhook';

/** 按类型/URL 特征创建发送器（R5）。auto：day.app→Bark，主机名含 ntfy→ntfy，其余→通用 Webhook。 */
export function createPushSender(options: {
  type?: PushSenderType | undefined;
  url: string;
  fetch?: typeof globalThis.fetch | undefined;
}): WebhookPushSender | BarkPushSender | NtfyPushSender {
  const validated = validateWebhookUrl(options.url);
  if (!validated) throw new Error('Invalid notification URL');
  const host = new URL(validated).hostname;
  const type =
    options.type && options.type !== 'auto'
      ? options.type
      : host.endsWith('day.app')
        ? 'bark'
        : host.includes('ntfy')
          ? 'ntfy'
          : 'webhook';
  if (type === 'bark') return new BarkPushSender({ url: validated, fetch: options.fetch });
  if (type === 'ntfy') return new NtfyPushSender({ url: validated, fetch: options.fetch });
  return new WebhookPushSender({ url: validated, fetch: options.fetch });
}

export type PushNotificationRouterOptions = {
  /** 全局 webhook 发送（单目标、每事件一次；配置为空时不发送）。运行时由闭包读取最新配置（R3）。 */
  webhookSender?: PushSender | undefined;
  /** 按设备发送（apns/fcm 预留；与 webhook 目标语义分离，R6）。 */
  deviceSender?: PushSender | undefined;
  resolveSessionTitle?: ((sessionId: string) => string | undefined) | undefined;
  preferences?: Partial<PushNotificationPreferences> | undefined;
  /** 通知投递失败回调（通知失败绝不影响主链路，R4）。 */
  onDeliveryError?: ((error: unknown) => void) | undefined;
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

/** 免打扰判定：start 含 end 不含，支持跨午夜；按 Bridge 所在电脑系统时区。 */
export function isWithinQuietHours(quiet: { start: string; end: string }, now: Date): boolean {
  const start = parseHm(quiet.start);
  const end = parseHm(quiet.end);
  if (start === undefined || end === undefined || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

const MAX_DEDUPE_EVENTS = 2000;

export class PushNotificationRouter {
  private readonly registrations = new Map<string, PushRegistration>();
  private readonly webhookSender: PushSender | undefined;
  private readonly deviceSender: PushSender | undefined;
  private readonly resolveSessionTitle: ((sessionId: string) => string | undefined) | undefined;
  private readonly onDeliveryError: ((error: unknown) => void) | undefined;
  private readonly seenEventIds = new Set<string>();
  private preferences: PushNotificationPreferences = { ...DEFAULT_PUSH_PREFERENCES };

  constructor(options: PushNotificationRouterOptions = {}) {
    this.webhookSender = options.webhookSender;
    this.deviceSender = options.deviceSender;
    this.resolveSessionTitle = options.resolveSessionTitle;
    this.onDeliveryError = options.onDeliveryError;
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

  /** 设置页「发送测试通知」：使用调用方给定的草稿 URL（R10），不受免打扰/静音影响。 */
  async notifyTest(sender: PushSender): Promise<void> {
    await sender({
      deviceId: 'test',
      platform: 'unknown',
      provider: 'webhook',
      pushToken: 'test',
      sessionId: 'test-session',
      title: 'Nienie 测试通知',
      body: 'Webhook 连接成功。',
      clickUrl: 'nienie://home',
      timestamp: Date.now(),
    });
  }

  /** 事件通知：绝不抛出（R4）。投递策略：webhook 全局单目标一次；设备级（apns/fcm）按注册逐设备。 */
  async notifyEvent(
    event: CanonicalAgentEvent,
    context: { sessionTitle?: string | undefined; now?: Date } = {},
  ): Promise<void> {
    try {
      if (!this.shouldDeliver(event, context.now ?? new Date())) return;
      const sessionLabel =
        context.sessionTitle ?? this.resolveSessionTitle?.(event.sessionId) ?? event.sessionId;
      const message = this.composeMessage(event, sessionLabel);
      if (!message) return;
      const timestamp = Date.now();
      const tasks: Array<Promise<void>> = [];
      if (this.webhookSender) {
        tasks.push(this.webhookSender({ ...message, platform: 'unknown', provider: 'webhook', pushToken: 'webhook', deviceId: 'webhook', timestamp }));
      }
      if (this.deviceSender) {
        const seen = new Set<string>();
        for (const reg of this.registrations.values()) {
          const key = `${reg.provider}:${reg.pushToken}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tasks.push(this.deviceSender({ ...message, deviceId: reg.deviceId, platform: reg.platform, provider: reg.provider, pushToken: reg.pushToken, timestamp }));
        }
      }
      await Promise.all(tasks);
    } catch (error) {
      this.onDeliveryError?.(error);
    }
  }

  private composeMessage(
    event: CanonicalAgentEvent,
    sessionLabel: string,
  ): { sessionId: string; title: string; body: string; clickUrl: string } | undefined {
    const detailed = this.preferences.detailed;
    let title: string | undefined;
    let rawBody: string | undefined;
    if (event.type === 'status' && event.payload['status'] === 'waiting') {
      title = 'Nienie · 等待你的批准';
      rawBody =
        typeof event.payload['detail'] === 'string'
          ? `${sessionLabel}：${event.payload['detail']}`
          : `${sessionLabel}：Agent 正在等待审批`;
    } else if (event.type === 'status' && event.payload['status'] === 'idle') {
      title = 'Nienie · 任务完成';
      rawBody = `${sessionLabel}：Agent 已完成本轮任务。`;
    } else if (event.type === 'error') {
      title = 'Nienie · 执行出错';
      rawBody =
        typeof event.payload['message'] === 'string'
          ? `${sessionLabel}：${event.payload['message']}`
          : `${sessionLabel}：Agent 执行失败`;
    }
    if (!title || !rawBody) return undefined;
    return {
      sessionId: event.sessionId,
      title,
      body: sanitizePushBody(rawBody, detailed),
      clickUrl: `nienie://session/${event.sessionId}`,
    };
  }

  private shouldDeliver(event: CanonicalAgentEvent, now: Date): boolean {
    if (!this.preferences.enabled) return false;
    if (!this.webhookSender && !this.deviceSender) return false;
    if (this.preferences.mutedSessionIds.includes(event.sessionId)) return false;
    if (this.preferences.quietHours && isWithinQuietHours(this.preferences.quietHours, now)) return false;
    // 事件级去重：同 eventId 只推一次（重复投递不产生重复通知）
    const key = `${event.sessionId}#${event.streamEpoch}#${event.eventId}`;
    if (this.seenEventIds.has(key)) return false;
    this.seenEventIds.add(key);
    if (this.seenEventIds.size > MAX_DEDUPE_EVENTS) {
      const first = this.seenEventIds.values().next().value;
      if (first !== undefined) this.seenEventIds.delete(first);
    }
    return true;
  }
}
