import { createAgentInfo, type AgentAdapter } from '@nienie/agent-events';
import type {
  AgentSession,
  AgentStatus,
  CanonicalAgentEvent,
  CreateSessionInput,
  PermissionDecision,
} from '@nienie/protocol';
import { OpenCodeEventNormalizer, type OpenCodeNormalizerOptions } from './normalizer.js';
import { parseSseStream } from './sse.js';

export { OpenCodeEventNormalizer, type OpenCodeNormalizerOptions } from './normalizer.js';
export { parseSseStream } from './sse.js';

const DEFAULT_OPENCODE_URL = 'http://127.0.0.1:4096';
const DEFAULT_DETECT_TIMEOUT_MS = 2000;

const capabilities = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  fileChanges: true,
  permissionRequests: true,
  modelSwitch: true,
  sessionResume: true,
  cancel: true,
} as const;

export type OpenCodeAdapterOptions = OpenCodeNormalizerOptions & {
  baseUrl?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  directory?: string | undefined;
  detectTimeoutMs?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

type OpenCodeRawSession = {
  id: string;
  title?: string;
  directory?: string;
  time?: {
    created?: number | string;
    updated?: number | string;
  };
};

type OpenCodeRawStatusMap = Record<
  string,
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt?: number; message?: string; next?: number }
>;

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode' as const;
  readonly name = 'OpenCode';
  readonly capabilities = { ...capabilities };

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string | undefined;
  private readonly directory: string | undefined;
  private readonly detectTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly normalizer: OpenCodeEventNormalizer;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();

  private sseAbortController: AbortController | undefined;
  private sseLoopPromise: Promise<void> | undefined;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.NIENIE_OPENCODE_URL ??
      DEFAULT_OPENCODE_URL
    ).replace(/\/+$/, '');
    this.username =
      options.username ??
      process.env.NIENIE_OPENCODE_USERNAME ??
      'opencode';
    this.password =
      options.password ??
      process.env.NIENIE_OPENCODE_PASSWORD;
    this.directory = options.directory;
    this.detectTimeoutMs = options.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.normalizer = new OpenCodeEventNormalizer(options);
  }

  async detect() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.detectTimeoutMs);

    try {
      const response = await this.fetchImpl(this.buildUrl('/global/health'), {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal,
      });
      if (!response.ok) {
        return createAgentInfo(this, false);
      }
      const data = (await response.json()) as { healthy?: boolean; version?: string };
      if (!data?.healthy) {
        return createAgentInfo(this, false);
      }
      return createAgentInfo(
        this,
        true,
        typeof data.version === 'string' ? data.version : undefined,
      );
    } catch {
      return createAgentInfo(this, false);
    } finally {
      clearTimeout(timer);
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    const [sessionsRes, statusMap] = await Promise.all([
      this.requestJson<OpenCodeRawSession[]>('/session', { method: 'GET' }),
      this.fetchStatusMap(),
    ]);

    return sessionsRes.map((raw) => this.mapSession(raw, statusMap[raw.id]));
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const query = input.projectPath ? { directory: input.projectPath } : undefined;
    const body: Record<string, unknown> = {};
    if (input.title) body.title = input.title;
    if (input.parentSessionId) body.parentID = input.parentSessionId;

    const raw = await this.requestJson<OpenCodeRawSession>('/session', {
      method: 'POST',
      query,
      body,
    });

    return this.mapSession(raw, { type: 'idle' }, input.projectPath);
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    const encodedId = encodeURIComponent(sessionId);
    const [raw, statusMap] = await Promise.all([
      this.requestJson<OpenCodeRawSession>(`/session/${encodedId}`, { method: 'GET' }),
      this.fetchStatusMap(),
    ]);

    return this.mapSession(raw, statusMap[sessionId]);
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    if (!this.sseAbortController) {
      await this.connectEvents().catch(() => undefined);
    }

    const encodedId = encodeURIComponent(sessionId);
    const response = await this.fetchImpl(this.buildUrl(`/session/${encodedId}/prompt_async`), {
      method: 'POST',
      headers: this.buildHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        parts: [
          {
            type: 'text',
            text: message,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Failed to send message to OpenCode session ${sessionId} (${response.status}): ${detail || response.statusText}`,
      );
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const encodedId = encodeURIComponent(sessionId);
    const response = await this.fetchImpl(this.buildUrl(`/session/${encodedId}/abort`), {
      method: 'POST',
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Failed to cancel OpenCode session ${sessionId} (${response.status}): ${detail || response.statusText}`,
      );
    }
  }

  async replyPermission(
    sessionId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const encodedSessionId = encodeURIComponent(sessionId);
    const encodedPermId = encodeURIComponent(permissionId);
    const body =
      decision === 'allow_always'
        ? { response: 'always', remember: true }
        : decision === 'allow_once'
          ? { response: 'once', remember: false }
          : { response: 'reject', remember: false };

    const response = await this.fetchImpl(
      this.buildUrl(`/session/${encodedSessionId}/permissions/${encodedPermId}`),
      {
        method: 'POST',
        headers: this.buildHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Failed to reply permission ${permissionId} in OpenCode session ${sessionId} (${response.status}): ${detail || response.statusText}`,
      );
    }
  }

  async connectEvents(): Promise<void> {
    if (this.sseAbortController) {
      return;
    }

    const controller = new AbortController();
    this.sseAbortController = controller;

    const response = await this.fetchImpl(this.buildUrl('/event'), {
      method: 'GET',
      headers: this.buildHeaders({ accept: 'text/event-stream' }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      this.sseAbortController = undefined;
      throw new Error(`Failed to connect to OpenCode SSE stream (${response.status})`);
    }

    const stream = response.body;
    this.sseLoopPromise = (async () => {
      try {
        for await (const rawEvent of parseSseStream(stream)) {
          if (controller.signal.aborted) break;
          const normalized = this.normalizer.normalize(rawEvent);
          for (const event of normalized) {
            this.emit(event);
          }
        }
      } catch {
        // Ignore stream abort or disconnect errors when disposing
      } finally {
        if (this.sseAbortController === controller) {
          this.sseAbortController = undefined;
        }
      }
    })();
  }

  async dispose(): Promise<void> {
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = undefined;
    }
    if (this.sseLoopPromise) {
      await this.sseLoopPromise.catch(() => undefined);
      this.sseLoopPromise = undefined;
    }
    this.listeners.clear();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: CanonicalAgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async fetchStatusMap(): Promise<OpenCodeRawStatusMap> {
    try {
      return await this.requestJson<OpenCodeRawStatusMap>('/session/status', { method: 'GET' });
    } catch {
      return {};
    }
  }

  private mapSession(
    raw: OpenCodeRawSession,
    rawStatus?: OpenCodeRawStatusMap[string],
    fallbackDirectory?: string,
  ): AgentSession {
    const cachedStatus = this.normalizer.getSessionStatus(raw.id);
    const status = cachedStatus ?? mapOpenCodeSessionStatus(rawStatus);
    const createdAt = toIsoTimestamp(raw.time?.created);
    const updatedAt = toIsoTimestamp(raw.time?.updated ?? raw.time?.created);

    return {
      id: raw.id,
      agentId: 'opencode',
      title: raw.title?.trim() || 'Untitled session',
      projectPath: raw.directory ?? fallbackDirectory ?? this.directory ?? '',
      status,
      createdAt,
      updatedAt,
    };
  }

  private async requestJson<T>(
    pathname: string,
    options: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      query?: Record<string, string | undefined> | undefined;
      body?: unknown;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let bodyText: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyText = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(this.buildUrl(pathname, options.query), {
      method: options.method,
      headers: this.buildHeaders(headers),
      ...(bodyText !== undefined ? { body: bodyText } : {}),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `OpenCode request ${options.method} ${pathname} failed (${response.status}): ${detail || response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }

  private buildUrl(pathname: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${this.baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
    const directory = query?.directory ?? this.directory;
    if (directory) {
      url.searchParams.set('directory', directory);
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (key !== 'directory' && value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.password) {
      const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      headers.authorization = `Basic ${token}`;
    }
    if (this.directory) {
      headers['x-opencode-directory'] = this.directory;
    }
    return headers;
  }
}

function mapOpenCodeSessionStatus(
  status?: OpenCodeRawStatusMap[string],
): AgentStatus {
  if (!status) return 'idle';
  if (status.type === 'busy' || status.type === 'retry') return 'running';
  return 'idle';
}

function toIsoTimestamp(value?: number | string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date(0).toISOString();
}
