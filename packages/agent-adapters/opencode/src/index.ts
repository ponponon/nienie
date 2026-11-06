import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAgentInfo, type AgentAdapter } from '@nienie/agent-events';
import type {
  AgentSession,
  AgentStatus,
  CanonicalAgentEvent,
  CreateSessionInput,
  ModelInfo,
  PermissionDecision,
  SessionFileDiff,
} from '@nienie/protocol';
import { OpenCodeEventNormalizer, type OpenCodeNormalizerOptions } from './normalizer.js';
import { parseSseStream } from './sse.js';

export { OpenCodeEventNormalizer, type OpenCodeNormalizerOptions } from './normalizer.js';
export { parseSseStream } from './sse.js';

const execFileAsync = promisify(execFile);
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
  executablePath?: string | undefined;
  autoStartServer?: boolean | undefined;
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
  readonly id: 'opencode' | 'mimo';
  readonly name: string;
  readonly capabilities = { ...capabilities };

  private readonly baseUrl: string;
  private readonly executablePath: string;
  private readonly autoStartServer: boolean;
  private readonly username: string;
  private readonly password: string | undefined;
  private readonly directory: string | undefined;
  private readonly detectTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly normalizer: OpenCodeEventNormalizer;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();

  private sseAbortController: AbortController | undefined;
  private sseLoopPromise: Promise<void> | undefined;
  private managedServerProcess: ChildProcess | undefined;

  constructor(
    options: OpenCodeAdapterOptions & {
      agentId?: 'opencode' | 'mimo' | undefined;
      agentName?: string | undefined;
      defaultUrl?: string | undefined;
      defaultBinaryName?: string | undefined;
    } = {},
  ) {
    this.id = options.agentId ?? 'opencode';
    this.name = options.agentName ?? 'OpenCode';
    const envUrl =
      this.id === 'mimo' ? process.env.NIENIE_MIMO_URL : process.env.NIENIE_OPENCODE_URL;
    const envBin =
      this.id === 'mimo' ? process.env.NIENIE_MIMO_BIN : process.env.NIENIE_OPENCODE_BIN;
    const fallbackUrl = options.defaultUrl ?? DEFAULT_OPENCODE_URL;
    this.baseUrl = (options.baseUrl ?? envUrl ?? fallbackUrl).replace(/\/+$/, '');
    this.executablePath = resolveOpenCodeBinary(
      options.executablePath ?? envBin,
      options.defaultBinaryName ?? (this.id === 'mimo' ? 'mimo' : 'opencode'),
    );
    this.autoStartServer =
      options.autoStartServer ?? (!options.baseUrl && !options.fetch && !envUrl);
    this.username =
      options.username ??
      process.env.NIENIE_OPENCODE_USERNAME ??
      this.id;
    this.password =
      options.password ??
      process.env.NIENIE_OPENCODE_PASSWORD;
    this.directory = options.directory;
    this.detectTimeoutMs = options.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.normalizer = new OpenCodeEventNormalizer({ ...options, agentId: this.id });
  }

  async detect() {
    const health = await this.checkHealth();
    if (health.healthy) {
      return createAgentInfo(this, true, health.version);
    }

    if (this.autoStartServer) {
      const cliVersion = await this.detectCliVersion();
      if (cliVersion) {
        await this.ensureManagedServerRunning();
        const afterStart = await this.checkHealth();
        return createAgentInfo(this, true, afterStart.version ?? cliVersion);
      }
    }

    return createAgentInfo(this, false);
  }

  private async checkHealth(): Promise<{ healthy: boolean; version?: string | undefined }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.detectTimeoutMs);

    try {
      const response = await this.fetchImpl(this.buildUrl('/global/health'), {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { healthy: false };
      }
      const data = (await response.json()) as { healthy?: boolean; version?: string };
      if (!data?.healthy) {
        return { healthy: false };
      }
      return {
        healthy: true,
        version: typeof data.version === 'string' ? data.version : undefined,
      };
    } catch {
      return { healthy: false };
    } finally {
      clearTimeout(timer);
    }
  }

  private async detectCliVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(this.executablePath, ['--version'], {
        timeout: 3000,
        env: buildAugmentedEnv(),
      });
      const raw = stdout.trim();
      if (!raw) return undefined;
      const match = raw.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      return match?.[1] ?? raw;
    } catch {
      return undefined;
    }
  }

  private async ensureManagedServerRunning(): Promise<void> {
    const current = await this.checkHealth();
    if (current.healthy) return;

    if (!this.managedServerProcess || this.managedServerProcess.killed) {
      try {
        const parsed = new URL(this.baseUrl);
        const port = parsed.port || '4096';
        const hostname = parsed.hostname || '127.0.0.1';
        const child = spawn(
          this.executablePath,
          ['serve', '--pure', '--port', port, '--hostname', hostname],
          {
            cwd: this.directory || process.cwd(),
            stdio: 'ignore',
            env: buildAugmentedEnv(),
          },
        );
        child.once('exit', () => {
          if (this.managedServerProcess === child) {
            this.managedServerProcess = undefined;
          }
        });
        this.managedServerProcess = child;
      } catch {
        return;
      }
    }

    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 220));
      const check = await this.checkHealth();
      if (check.healthy) return;
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    if (this.autoStartServer) {
      await this.ensureManagedServerRunning();
    }
    const [sessionsRes, statusMap, projectsRes] = await Promise.all([
      this.requestJson<OpenCodeRawSession[]>('/session', { method: 'GET' }),
      this.fetchStatusMap(),
      this.requestJson<Array<{ id?: string; worktree?: string }>>('/project', {
        method: 'GET',
      }).catch(() => []),
    ]);

    const mapped = sessionsRes.map((raw) => this.mapSession(raw, statusMap[raw.id]));
    const coveredDirs = new Set(mapped.map((s) => s.projectPath).filter(Boolean));

    for (const proj of projectsRes) {
      const dir = proj.worktree?.trim();
      if (!dir || dir === '/' || coveredDirs.has(dir)) continue;
      coveredDirs.add(dir);
      const folder = dir.split('/').filter(Boolean).pop() ?? 'workspace';
      const nowIso = new Date().toISOString();
      mapped.push({
        id: `${this.id}_proj_${proj.id ?? folder}`,
        agentId: this.id,
        title: `${folder} 默认会话`,
        projectPath: dir,
        status: 'idle',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }

    return mapped;
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await this.requestJson<{
      providers?: Array<{
        id: string;
        name?: string;
        models?: Record<string, { id?: string; name?: string }>;
      }>;
      default?: Record<string, string>;
    }>('/config/providers', { method: 'GET' });

    const models: ModelInfo[] = [];
    const defaults = data.default ?? {};

    for (const provider of data.providers ?? []) {
      const providerId = provider.id;
      const providerName = provider.name ?? providerId;
      const defaultModelId = defaults[providerId];

      for (const [key, model] of Object.entries(provider.models ?? {})) {
        const modelId = model.id ?? key;
        models.push({
          id: `${providerId}/${modelId}`,
          name: model.name ?? modelId,
          providerId,
          providerName,
          isDefault: defaultModelId === modelId,
        });
      }
    }

    return models;
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    if (this.autoStartServer) {
      await this.ensureManagedServerRunning();
    }
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

  async getSessionDiff(sessionId: string): Promise<SessionFileDiff[]> {
    const encodedId = encodeURIComponent(sessionId);
    return this.requestJson<SessionFileDiff[]>(`/session/${encodedId}/diff`, {
      method: 'GET',
    });
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    if (this.autoStartServer) {
      await this.ensureManagedServerRunning();
    }
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
    if (this.managedServerProcess) {
      this.managedServerProcess.kill('SIGTERM');
      this.managedServerProcess = undefined;
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
      agentId: this.id,
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

export type MiMoCodeAdapterOptions = OpenCodeAdapterOptions;

export class MiMoCodeAdapter extends OpenCodeAdapter {
  constructor(options: MiMoCodeAdapterOptions = {}) {
    super({
      ...options,
      agentId: 'mimo',
      agentName: 'MiMo Code',
      defaultUrl: 'http://127.0.0.1:4097',
      defaultBinaryName: 'mimo',
    });
  }
}

function resolveOpenCodeBinary(explicit?: string, binaryName = 'opencode'): string {
  if (explicit) return explicit;
  const home = homedir();
  const candidates = [
    join(home, `.bun/bin/${binaryName}`),
    join(home, `.local/bin/${binaryName}`),
    `/opt/homebrew/bin/${binaryName}`,
    `/usr/local/bin/${binaryName}`,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return binaryName;
}

function buildAugmentedEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extraPaths = [
    join(home, '.bun/bin'),
    join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const currentPath = process.env.PATH ?? '';
  return {
    ...process.env,
    PATH: [...extraPaths, currentPath].filter(Boolean).join(':'),
  };
}
