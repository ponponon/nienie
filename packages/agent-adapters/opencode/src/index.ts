import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAgentInfo, createCanonicalEvent, type AgentAdapter } from '@nienie/agent-events';
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

  private readonly sseConnections = new Map<
    string,
    { controller: AbortController; loop: Promise<void> }
  >();
  private managedServerProcess: ChildProcess | undefined;
  private readonly sessionDirectories = new Map<string, string>();
  private readonly loadedHistorySessions = new Set<string>();
  private historySeqCounter = 0;

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
      const dbSessions = this.readLocalSqliteSessions();
      if (dbSessions.length > 0) {
        return dbSessions;
      }
      await this.ensureManagedServerRunning();
    }
    const [sessionsRes, statusMap] = await Promise.all([
      this.requestJson<OpenCodeRawSession[]>('/session', { method: 'GET' }),
      this.fetchStatusMap(),
    ]);

    return sessionsRes.map((raw) => this.mapSession(raw, statusMap[raw.id]));
  }

  private readLocalSqliteSessions(): AgentSession[] {
    const dbFolder = this.id === 'mimo' ? 'mimocode' : 'opencode';
    const dbName = this.id === 'mimo' ? 'mimocode.db' : 'opencode.db';
    const dbPath = join(homedir(), '.local/share', dbFolder, dbName);
    if (!existsSync(dbPath)) return [];

    try {
      const out = execFileSync(
        'sqlite3',
        [
          '-json',
          dbPath,
          'SELECT id, title, directory, time_created, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 120;',
        ],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const rows = JSON.parse(out || '[]') as Array<{
        id?: string;
        title?: string;
        directory?: string;
        time_created?: number;
        time_updated?: number;
      }>;
      const results: AgentSession[] = [];
      for (const row of rows) {
        if (!row.id) continue;
        const dir = row.directory?.trim() || this.directory || '';
        this.sessionDirectories.set(row.id, dir);
        const cachedStatus = this.normalizer.getSessionStatus(row.id) ?? 'idle';
        results.push({
          id: row.id,
          agentId: this.id,
          title: row.title?.trim() || 'Untitled session',
          projectPath: dir,
          status: cachedStatus,
          createdAt: toIsoTimestamp(row.time_created),
          updatedAt: toIsoTimestamp(row.time_updated ?? row.time_created),
        });
      }
      return results;
    } catch {
      return [];
    }
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

    if (input.projectPath) {
      this.sessionDirectories.set(raw.id, input.projectPath);
    }

    return this.mapSession(raw, { type: 'idle' }, input.projectPath);
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    if (this.autoStartServer) {
      if (!this.loadedHistorySessions.has(sessionId)) {
        this.loadedHistorySessions.add(sessionId);
        this.emitSqliteSessionHistory(sessionId);
      }
      const dbSessions = this.readLocalSqliteSessions();
      const foundInDb = dbSessions.find((s) => s.id === sessionId);
      if (foundInDb) {
        return foundInDb;
      }
      await this.ensureManagedServerRunning();
    }
    const encodedId = encodeURIComponent(sessionId);
    const knownDir = this.sessionDirectories.get(sessionId);
    await this.connectEvents(knownDir).catch(() => undefined);
    const query = knownDir ? { directory: knownDir } : undefined;
    const [raw, statusMap] = await Promise.all([
      this.requestJson<OpenCodeRawSession>(`/session/${encodedId}`, {
        method: 'GET',
        query,
      }),
      this.fetchStatusMap(),
    ]);

    return this.mapSession(raw, statusMap[sessionId], knownDir);
  }

  private emitSqliteSessionHistory(sessionId: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return;
    const dbFolder = this.id === 'mimo' ? 'mimocode' : 'opencode';
    const dbName = this.id === 'mimo' ? 'mimocode.db' : 'opencode.db';
    const dbPath = join(homedir(), '.local/share', dbFolder, dbName);
    if (!existsSync(dbPath)) return;

    try {
      const sql = `SELECT json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.type') AS part_type, json_extract(p.data, '$.text') AS text, json_extract(p.data, '$.tool') AS tool, json_extract(p.data, '$.callID') AS call_id, substr(json_extract(p.data, '$.state.output'), 1, 500) AS tool_output FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id = '${sessionId}' AND json_extract(p.data, '$.synthetic') IS NOT 1 ORDER BY p.time_created ASC LIMIT 120;`;
      const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const rows = JSON.parse(out || '[]') as Array<{
        role?: string;
        part_type?: string;
        text?: string | null;
        tool?: string | null;
        call_id?: string | null;
        tool_output?: string | null;
      }>;

      for (const row of rows) {
        const text = (row.text ?? '').trim();
        if (
          text.startsWith('<system-reminder>') ||
          text.startsWith('[Attachments] The user attached')
        ) {
          continue;
        }
        if (row.role === 'user' && row.part_type === 'text' && text) {
          this.emit(
            createCanonicalEvent({
              eventId: `hist_${randomUUID()}`,
              agentId: this.id,
              sessionId,
              sequence: ++this.historySeqCounter,
              timestamp: new Date().toISOString(),
              type: 'text_delta',
              payload: { delta: text, role: 'user' },
            }),
          );
        } else if (row.role === 'assistant' && row.part_type === 'text' && text) {
          this.emit(
            createCanonicalEvent({
              eventId: `hist_${randomUUID()}`,
              agentId: this.id,
              sessionId,
              sequence: ++this.historySeqCounter,
              timestamp: new Date().toISOString(),
              type: 'text_delta',
              payload: { delta: `${text}\n` },
            }),
          );
        } else if (row.role === 'assistant' && row.part_type === 'tool' && row.tool) {
          const callId = row.call_id || `call_${++this.historySeqCounter}`;
          this.emit(
            createCanonicalEvent({
              eventId: `hist_${randomUUID()}`,
              agentId: this.id,
              sessionId,
              sequence: ++this.historySeqCounter,
              timestamp: new Date().toISOString(),
              type: 'tool_use',
              payload: { toolCallId: callId, name: row.tool, input: {} },
            }),
          );
          if (row.tool_output) {
            this.emit(
              createCanonicalEvent({
                eventId: `hist_${randomUUID()}`,
                agentId: this.id,
                sessionId,
                sequence: ++this.historySeqCounter,
                timestamp: new Date().toISOString(),
                type: 'tool_result',
                payload: {
                  toolCallId: callId,
                  content: row.tool_output,
                  isError: false,
                },
              }),
            );
          }
        }
      }
    } catch {
      // Ignore sqlite history read errors
    }
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
    const knownDir = this.sessionDirectories.get(sessionId);
    await this.connectEvents(knownDir).catch(() => undefined);

    const encodedId = encodeURIComponent(sessionId);
    const query = knownDir ? { directory: knownDir } : undefined;
    const response = await this.fetchImpl(
      this.buildUrl(`/session/${encodedId}/prompt_async`, query),
      {
        method: 'POST',
        headers: this.buildHeaders({
          'content-type': 'application/json',
          ...(knownDir ? { 'x-opencode-directory': knownDir } : {}),
        }),
        body: JSON.stringify({
          parts: [
            {
              type: 'text',
              text: message,
            },
          ],
        }),
      },
    );

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

  async connectEvents(directory?: string): Promise<void> {
    const effectiveDir = directory ?? this.directory;
    const key = effectiveDir ?? '';
    if (this.sseConnections.has(key)) {
      return;
    }

    const controller = new AbortController();
    const response = await this.fetchImpl(
      this.buildUrl('/event', effectiveDir ? { directory: effectiveDir } : undefined),
      {
        method: 'GET',
        headers: this.buildHeaders({
          accept: 'text/event-stream',
          ...(effectiveDir ? { 'x-opencode-directory': effectiveDir } : {}),
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok || !response.body) {
      controller.abort();
      throw new Error(`Failed to connect to OpenCode SSE stream (${response.status})`);
    }

    const stream = response.body;
    const loop = (async () => {
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
        const current = this.sseConnections.get(key);
        if (current?.controller === controller) {
          this.sseConnections.delete(key);
        }
      }
    })();

    this.sseConnections.set(key, { controller, loop });
  }

  async dispose(): Promise<void> {
    const connections = [...this.sseConnections.values()];
    this.sseConnections.clear();
    for (const { controller } of connections) {
      controller.abort();
    }
    for (const { loop } of connections) {
      await loop.catch(() => undefined);
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
