import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createAgentInfo,
  createCanonicalEvent,
  AgentEventConnectionManager,
  type AgentAdapter,
} from '@nienie/agent-events';
import { SESSION_SNAPSHOT_SCHEMA_VERSION } from '@nienie/protocol';
import type {
  AgentSession,
  AgentStatus,
  CanonicalAgentEvent,
  CanonicalAgentEventType,
  CreateSessionInput,
  ModelInfo,
  PermissionDecision,
  SessionFileDiff,
  SessionSnapshot,
  SessionSnapshotPart,
} from '@nienie/protocol';
import { OpenCodeEventNormalizer, type OpenCodeNormalizerOptions } from './normalizer.js';
import { parseSseStream } from './sse.js';

export { OpenCodeEventNormalizer, type OpenCodeNormalizerOptions } from './normalizer.js';
export { parseSseStream } from './sse.js';
export {
  discoverOpenCodeService,
  openCodeRegistrationFiles,
  openCodeServiceAuthHeader,
  openCodeStateDir,
  openCodeStateDirs,
  readOpenCodeServiceRegistration,
  verifyOpenCodeService,
  type DiscoverOpenCodeServiceOptions,
  type OpenCodeServiceDiscoveryReason,
  type OpenCodeServiceDiscoveryResult,
  type OpenCodeServiceEndpoint,
  type OpenCodeServiceRegistration,
  type VerifyOpenCodeServiceOptions,
} from './service-discovery.js';

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

  private readonly eventManager: AgentEventConnectionManager<unknown>;
  private managedServerProcess: ChildProcess | undefined;
  private readonly sessionDirectories = new Map<string, string>();
  private readonly loadedHistorySessions = new Set<string>();
  private historySeqCounter = 0;
  /** partId → 已回放的文本长度，用于增量补发缺失后缀（幂等 + 捕获 UPDATE）。 */
  private readonly emittedPartLength = new Map<string, number>();
  /** 已回放的 tool callId（tool_use 只发一次）。 */
  private readonly emittedToolUse = new Set<string>();
  /** callId → 已回放的 tool_result 内容长度，延迟/增长的 result 增量补发。 */
  private readonly emittedToolResultLength = new Map<string, number>();
  /** 历史恢复告警/失败记录，暴露到诊断。 */
  private readonly historyRecoveryErrors: string[] = [];

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
    this.eventManager = new AgentEventConnectionManager<unknown>({
      connect: (key, signal) => this.connectEventStream(key, signal),
      onEvent: (raw) => {
        for (const event of this.normalizer.normalize(raw)) {
          this.emit(event);
        }
      },
      onReconnect: (key) => this.compensateHistoryForKey(key),
    });
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

    // 应用 OpenCode Desktop 的模型可见性（用户配置的显示/隐藏），与桌面端对齐
    const visibility = this.readModelVisibility();
    const filtered = visibility
      ? models.filter((m) => visibility[m.id] !== 'hide')
      : models;

    return filtered;
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
      // 增量回放：按 partId + 已回放长度只补发缺失后缀，幂等且能捕获 UPDATE。
      // 不用 rowid 水位（rowid 无法发现已有行的内容更新）。
      const pageSize = 200;
      // 完整分页：循环到取尽，不用硬上限静默截断；超大安全上限才告警。
      const maxRows = 20000;
      let totalRead = 0;
      for (let offset = 0; ; offset += pageSize) {
        const sql = `SELECT json_extract(p.data, '$.id') AS part_id, json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.type') AS part_type, json_extract(p.data, '$.text') AS text, json_extract(p.data, '$.tool') AS tool, json_extract(p.data, '$.callID') AS call_id, json_extract(p.data, '$.state.output') AS tool_output, json_extract(p.data, '$.state.input') AS tool_input, json_extract(p.data, '$.state.status') AS tool_status, json_extract(p.data, '$.state.error') AS tool_error FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id = '${sessionId}' AND json_extract(p.data, '$.synthetic') IS NOT 1 ORDER BY p.rowid ASC LIMIT ${offset}, ${pageSize};`;
        const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const rows = JSON.parse(out || '[]') as Array<{
          part_id?: string | null;
          role?: string;
          part_type?: string;
          text?: string | null;
          tool?: string | null;
          call_id?: string | null;
          tool_output?: string | null;
          tool_input?: string | null;
          tool_status?: string | null;
          tool_error?: string | null;
        }>;
        if (rows.length === 0) break;
        totalRead += rows.length;

        for (const row of rows) {
          const partId = row.part_id ?? `part_${++this.historySeqCounter}`;
          const text = row.text ?? '';
          const emitted = this.emittedPartLength.get(partId) ?? 0;
          const trimmed = text.trim();

          if (row.role === 'user' && row.part_type === 'text') {
            if (
              trimmed.startsWith('<system-reminder>') ||
              trimmed.startsWith('[Attachments] The user attached')
            ) {
              this.emittedPartLength.set(partId, text.length);
              continue;
            }
            if (text.length > emitted) {
              this.emittedPartLength.set(partId, text.length);
              this.emitTextDelta(sessionId, partId, text.length, text.slice(emitted), 'user');
            }
          } else if (row.role === 'assistant' && row.part_type === 'text') {
            if (trimmed.startsWith('<system-reminder>')) {
              this.emittedPartLength.set(partId, text.length);
              continue;
            }
            if (text.length > emitted) {
              this.emittedPartLength.set(partId, text.length);
              this.emitTextDelta(sessionId, partId, text.length, text.slice(emitted), undefined);
            }
          } else if (row.role === 'assistant' && row.part_type === 'tool' && row.tool) {
            const callId = row.call_id || `call_${++this.historySeqCounter}`;
            // tool_use 只发一次
            if (!this.emittedToolUse.has(callId)) {
              this.emittedToolUse.add(callId);
              this.emit(
                createCanonicalEvent({
                  eventId: `history:${sessionId}:tool:${callId}`,
                  streamEpoch: this.normalizer.streamEpoch,
                  agentId: this.id,
                  sessionId,
                  sequence: this.normalizer.nextSequence(sessionId),
                  timestamp: new Date().toISOString(),
                  type: 'tool_use',
                  payload: { toolCallId: callId, name: row.tool, input: {} },
                }),
              );
            }
            // tool_result：发全量内容（手机端是覆盖语义，增量会导致只留后缀）
            const output = row.tool_output ?? '';
            const resultEmitted = this.emittedToolResultLength.get(callId) ?? -1;
            if (output.length > resultEmitted) {
              this.emittedToolResultLength.set(callId, output.length);
              this.emit(
                createCanonicalEvent({
                  eventId: `history:${sessionId}:tool:${callId}:result:${output.length}`,
                  streamEpoch: this.normalizer.streamEpoch,
                  agentId: this.id,
                  sessionId,
                  sequence: this.normalizer.nextSequence(sessionId),
                  timestamp: new Date().toISOString(),
                  type: 'tool_result',
                  payload: {
                    toolCallId: callId,
                    content: output,
                    isError: false,
                  },
                }),
              );
            }
          }
        }
        if (rows.length < pageSize) break;
        if (totalRead >= maxRows) {
          // 安全上限：超大 session 保护，不静默——记录并停止
          this.emitDiagnosticWarning(`history replay truncated at ${maxRows} rows for ${sessionId}`);
          break;
        }
      }
    } catch {
      // Ignore sqlite history read errors
    }
  }

  /** 记录历史恢复告警（截断/失败），供诊断暴露，不静默。 */
  private emitDiagnosticWarning(message: string): void {
    this.historyRecoveryErrors.push(`${new Date().toISOString()}: ${message}`);
    if (this.historyRecoveryErrors.length > 50) {
      this.historyRecoveryErrors.shift();
    }
  }

  /** 回放文本增量：稳定 eventId + streamEpoch + partRevision，供客户端幂等去重。 */
  private emitTextDelta(
    sessionId: string,
    partId: string,
    revision: number,
    delta: string,
    role: string | undefined,
  ): void {
    this.emit(
      createCanonicalEvent({
        eventId: `history:${sessionId}:${partId}:${revision}`,
        streamEpoch: this.normalizer.streamEpoch,
        agentId: this.id,
        sessionId,
        sequence: this.normalizer.nextSequence(sessionId),
        timestamp: new Date().toISOString(),
        type: 'text_delta',
        payload: {
          delta,
          partId,
          partRevision: revision,
          ...(role ? { role } : {}),
        },
      }),
    );
  }

  /** 获取会话完整快照（Part 全量状态），供 resetRequired/truncated 时原子重建。 */
  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const empty: SessionSnapshot = {
      schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION,
      snapshotId: `snap_${Date.now()}`,
      sessionId,
      agentId: this.id,
      streamEpoch: this.normalizer.streamEpoch,
      watermark: this.normalizer.peekSequence(sessionId),
      capturedAt: new Date().toISOString(),
      complete: true,
      hasMore: false,
      totalParts: 0,
      parts: [],
    };
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return empty;
    const dbFolder = this.id === 'mimo' ? 'mimocode' : 'opencode';
    const dbName = this.id === 'mimo' ? 'mimocode.db' : 'opencode.db';
    const dbPath = join(homedir(), '.local/share', dbFolder, dbName);
    if (!existsSync(dbPath)) {
      // 数据库不可用：绝不返回空成功（那会误清空手机历史），明确报错
      throw new Error(`OpenCode session database unavailable for snapshot: ${sessionId}`);
    }
    try {
      // 分页读全（不再 LIMIT 5000 谎报 complete）：循环取尽所有 Part
      const pageSize = 500;
      const parts: SessionSnapshotPart[] = [];
      let ordinal = 0;
      const ts = new Date().toISOString();
      const safetyMaxRows = 100000;
      let sawUnhandled = false;
      let truncated = false;
      for (let offset = 0; offset < safetyMaxRows; offset += pageSize) {
        const sql = `SELECT json_extract(p.data, '$.id') AS part_id, json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.type') AS part_type, json_extract(p.data, '$.text') AS text, json_extract(p.data, '$.tool') AS tool, json_extract(p.data, '$.callID') AS call_id, json_extract(p.data, '$.state.output') AS tool_output, json_extract(p.data, '$.state.input') AS tool_input, json_extract(p.data, '$.state.status') AS tool_status, json_extract(p.data, '$.state.error') AS tool_error FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id = '${sessionId}' AND json_extract(p.data, '$.synthetic') IS NOT 1 ORDER BY p.rowid ASC LIMIT ${offset}, ${pageSize};`;
        const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const rows = JSON.parse(out || '[]') as Array<{
          part_id?: string | null;
          role?: string;
          part_type?: string;
          text?: string | null;
          tool?: string | null;
          call_id?: string | null;
          tool_output?: string | null;
          tool_input?: string | null;
          tool_status?: string | null;
          tool_error?: string | null;
        }>;
        if (rows.length === 0) break;
        for (const row of rows) {
          const partId = row.part_id ?? `part_${ordinal}`;
          const text = row.text ?? '';
          const base = { partId, ordinal: ordinal++, revision: 1, createdAt: ts, updatedAt: ts };
          if (row.role === 'user' && row.part_type === 'text' && text.trim()) {
            parts.push({ ...base, kind: 'message', role: 'user', content: [{ type: 'text', text }] });
          } else if (row.role === 'assistant' && row.part_type === 'text' && text) {
            parts.push({ ...base, kind: 'message', role: 'assistant', content: [{ type: 'text', text }] });
          } else if (row.role === 'assistant' && row.part_type === 'tool' && row.tool) {
            const output = row.tool_output ?? '';
            // 读真实 input/status/error，正确映射（completed 空输出 ≠ running、failed ≠ running）
            let input: Record<string, unknown> = {};
            try { input = row.tool_input ? JSON.parse(row.tool_input) : {}; } catch { input = {}; }
            const rawStatus = row.tool_status ?? '';
            const status = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'pending' ? rawStatus : (output ? 'completed' : 'running');
            const isError = row.tool_error != null && row.tool_error !== '';
            parts.push({
              ...base,
              kind: 'tool_call',
              toolCallId: row.call_id || partId,
              name: row.tool,
              input,
              status,
              ...(output ? { output } : {}),
              isError,
              ...(row.tool_error ? { output: String(row.tool_error) } : {}),
            });
          } else {
            // 未知/未支持 Part：不能静默丢弃并谎报 complete（J0-8）
            sawUnhandled = true;
          }
        }
        if (rows.length < pageSize) break;
        if (offset + pageSize >= safetyMaxRows && rows.length === pageSize) {
          truncated = true;
        }
      }
      if (sawUnhandled) {
        throw new Error('Snapshot contains unsupported part types; refusing to report complete');
      }
      if (truncated) {
        // 命中安全上限：绝不谎报 complete（J0-6/J0-7）
        throw new Error(`Snapshot exceeded ${safetyMaxRows} rows; refusing to report complete`);
      }
      return {
        ...empty,
        snapshotId: `snap_${Date.now()}_${sessionId}`,
        parts,
        totalParts: parts.length,
      };
    } catch (error) {
      this.emitDiagnosticWarning(`snapshot build failed for ${sessionId}`);
      // 读取失败绝不返回空成功
      throw new Error(`Failed to build session snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 读 OpenCode Desktop 的模型可见性（drafts.sqlite: opencode.global.dat:model）。 */
  private readModelVisibility(): Record<string, string> | null {
    try {
      const dbPath = join(
        homedir(),
        'Library',
        'Application Support',
        'ai.opencode.desktop',
        'drafts.sqlite',
      );
      if (!existsSync(dbPath)) return null;
      const out = execFileSync(
        'sqlite3',
        [
          '-json',
          dbPath,
          "SELECT value FROM state WHERE name='opencode.global.dat' AND key='model';",
        ],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const rows = JSON.parse(out || '[]') as Array<{ value?: string }>;
      const raw = rows[0]?.value;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        user?: Array<{ providerID?: string; modelID?: string; visibility?: string }>;
      };
      const map: Record<string, string> = {};
      for (const u of parsed.user ?? []) {
        if (u.providerID && u.modelID && u.visibility) {
          map[`${u.providerID}/${u.modelID}`] = u.visibility;
        }
      }
      return map;
    } catch {
      return null;
    }
  }

  async getSessionDiff(sessionId: string): Promise<SessionFileDiff[]> {
    const encodedId = encodeURIComponent(sessionId);
    return this.requestJson<SessionFileDiff[]>(`/session/${encodedId}/diff`, {
      method: 'GET',
    });
  }

  async sendMessage(
    sessionId: string,
    message: string,
    options?: { modelId?: string | undefined },
  ): Promise<void> {
    if (this.autoStartServer) {
      await this.ensureManagedServerRunning();
    }
    const knownDir = this.sessionDirectories.get(sessionId);
    // 强一致：SSE 事件流建立失败则不发送 Prompt，避免「Agent 生成了但手机收不到回复」
    await this.connectEvents(knownDir);

    const encodedId = encodeURIComponent(sessionId);
    const query = knownDir ? { directory: knownDir } : undefined;
    // modelId 格式为 `${providerId}/${modelId}`，拆开传给 OpenCode（否则用默认模型）
    const body: Record<string, unknown> = {
      parts: [
        {
          type: 'text',
          text: message,
        },
      ],
    };
    const modelId = options?.modelId;
    if (modelId) {
      const slash = modelId.indexOf('/');
      const providerID = slash > 0 ? modelId.slice(0, slash) : undefined;
      const modelID = slash > 0 ? modelId.slice(slash + 1) : modelId;
      body.model = {
        ...(providerID ? { providerID } : {}),
        modelID,
      };
    }
    const response = await this.fetchImpl(
      this.buildUrl(`/session/${encodedId}/prompt_async`, query),
      {
        method: 'POST',
        headers: this.buildHeaders({
          'content-type': 'application/json',
          ...(knownDir ? { 'x-opencode-directory': knownDir } : {}),
        }),
        body: JSON.stringify(body),
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
    const key = directory ?? this.directory ?? '';
    // waitUntilConnected 内部会按需启动 supervisor，并等待「当前」连接真正可用，
    // 避免 ensure + wait 双调用在失败时产生重复建连的竞态窗口。
    await this.eventManager.waitUntilConnected(key);
  }

  /** 建立某 directory（key）的 SSE 事件流，返回 raw 事件的 AsyncIterable。 */
  private async connectEventStream(
    key: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>> {
    const effectiveDir = key === '' ? undefined : key;
    const response = await this.fetchImpl(
      this.buildUrl('/event', effectiveDir ? { directory: effectiveDir } : undefined),
      {
        method: 'GET',
        headers: this.buildHeaders({
          accept: 'text/event-stream',
          ...(effectiveDir ? { 'x-opencode-directory': effectiveDir } : {}),
        }),
        signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Failed to connect to OpenCode SSE stream (${response.status})`);
    }
    return parseSseStream(response.body);
  }

  /** 断线重连后，对已加载的会话做事件历史补偿（增量回放，幂等）。 */
  private compensateHistoryForKey(key: string): void {
    for (const sessionId of this.loadedHistorySessions) {
      const dir = this.sessionDirectories.get(sessionId) ?? this.directory ?? '';
      if (dir === key) {
        this.emitSqliteSessionHistory(sessionId);
      }
    }
  }

  /** 暴露 SSE 连接诊断（供 Bridge /diagnostics 聚合）。 */
  getDiagnostics() {
    return {
      connections: this.eventManager.status(),
      historyRecoveryErrors: [...this.historyRecoveryErrors],
    };
  }

  async dispose(): Promise<void> {
    await this.eventManager.dispose();
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
    const directory = raw.directory ?? fallbackDirectory ?? this.directory;

    // 缓存 sessionId → directory，供 sendMessage/loadSession 定位正确的目录级事件流
    if (directory) {
      this.sessionDirectories.set(raw.id, directory);
    }

    return {
      id: raw.id,
      agentId: this.id,
      title: raw.title?.trim() || 'Untitled session',
      projectPath: directory ?? '',
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
    // 显式传入的会话目录优先，不被适配器默认目录覆盖
    if (this.directory && !headers['x-opencode-directory']) {
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
