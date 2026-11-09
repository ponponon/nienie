import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  createAgentInfo,
  createCanonicalEvent,
  DEFAULT_MAX_TOOL_OUTPUT_LENGTH,
  truncateOutput,
  type AgentAdapter,
} from '@nienie/agent-events';
import type {
  AgentSession,
  CanonicalAgentEvent,
  CreateSessionInput,
} from '@nienie/protocol';
import { CodexEventNormalizer, type CodexNormalizerOptions } from './normalizer.js';

export { CodexEventNormalizer, type CodexNormalizerOptions } from './normalizer.js';

const execFileAsync = promisify(execFile);

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

export type CodexProcessHandle = {
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
};

export type CodexSpawnOptions = {
  cwd?: string | undefined;
};

export type CodexAdapterOptions = CodexNormalizerOptions & {
  executablePath?: string | undefined;
  defaultProjectPath?: string | undefined;
  detectVersion?: (() => Promise<string>) | undefined;
  spawnProcess?: ((args: string[], options: CodexSpawnOptions) => CodexProcessHandle) | undefined;
};

type CodexSessionRecord = AgentSession & {
  threadId?: string | undefined;
};

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly name = 'Codex';
  readonly capabilities = { ...capabilities };

  private readonly executablePath: string;
  private readonly defaultProjectPath: string;
  private readonly detectVersionImpl: () => Promise<string>;
  private readonly spawnProcessImpl: (
    args: string[],
    options: CodexSpawnOptions,
  ) => CodexProcessHandle;
  private readonly normalizer: CodexEventNormalizer;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sessions = new Map<string, CodexSessionRecord>();
  private readonly activeProcesses = new Map<string, CodexProcessHandle>();
  private readonly discoverLocalHistory: boolean;
  private readonly loadedHistoryThreads = new Set<string>();
  private historyLoaded = false;
  /** itemId → 已回放文本长度，增量补发缺失后缀（幂等 + 捕获内容更新）。 */
  private readonly emittedTextLength = new Map<string, number>();
  /** 已回放的 tool（tool_use 只发一次）。 */
  private readonly emittedToolUse = new Set<string>();
  /** callId → 已回放 tool_result 长度，延迟/增长的 result 增量补发。 */
  private readonly emittedToolResultLength = new Map<string, number>();
  /** 历史恢复告警/失败记录，暴露到诊断。 */
  private readonly historyRecoveryErrors: string[] = [];

  constructor(options: CodexAdapterOptions = {}) {
    this.executablePath = resolveCodexBinary(
      options.executablePath ?? process.env.NIENIE_CODEX_BIN,
    );
    this.defaultProjectPath = options.defaultProjectPath ?? process.cwd();
    this.normalizer = new CodexEventNormalizer(options);
    this.discoverLocalHistory = !options.spawnProcess && !options.detectVersion;

    this.detectVersionImpl =
      options.detectVersion ??
      (async () => {
        const { stdout } = await execFileAsync(this.executablePath, ['--version'], {
          timeout: 3000,
          env: buildCodexEnv(),
        });
        return stdout.trim();
      });

    this.spawnProcessImpl =
      options.spawnProcess ??
      ((args, spawnOpts) => {
        const child = spawn(this.executablePath, args, {
          cwd: spawnOpts.cwd || this.defaultProjectPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildCodexEnv(),
        });
        return {
          stdout: child.stdout,
          stderr: child.stderr,
          kill() {
            child.kill('SIGTERM');
          },
          onExit(listener) {
            child.once('exit', (code) => listener(code));
          },
          onError(listener) {
            child.once('error', (err) => listener(err));
          },
        };
      });
  }

  async detect() {
    try {
      const rawVersion = await this.detectVersionImpl();
      if (!rawVersion) {
        return createAgentInfo(this, false);
      }
      const match = rawVersion.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      const version = match?.[1] ?? rawVersion.trim();
      return createAgentInfo(this, true, version);
    } catch {
      return createAgentInfo(this, false);
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    if (this.discoverLocalHistory && !this.historyLoaded) {
      this.historyLoaded = true;
      this.loadLocalCodexHistory();
    }
    return [...this.sessions.values()].map((record) => this.toAgentSession(record));
  }

  private loadLocalCodexHistory(): void {
    const home = homedir();
    const sqlitePath = resolveLatestCodexStateDb(join(home, '.codex'));
    if (sqlitePath) {
      try {
        const out = execFileSync(
          'sqlite3',
          [
            '-json',
            sqlitePath,
            'SELECT id, substr(title, 1, 80) AS title, cwd, created_at, updated_at FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 60;',
          ],
          { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const rows = JSON.parse(out || '[]') as Array<{
          id?: string;
          title?: string;
          cwd?: string;
          created_at?: number;
          updated_at?: number;
        }>;
        for (const row of rows) {
          if (!row.id || this.sessions.has(row.id)) continue;
          const cleanTitle = (row.title ?? '').replace(/\s+/g, ' ').trim();
          if (cleanTitle === 'Guardian review') continue;
          const createdIso = row.created_at
            ? new Date(row.created_at * 1000).toISOString()
            : new Date().toISOString();
          const updatedIso = row.updated_at
            ? new Date(row.updated_at * 1000).toISOString()
            : createdIso;
          this.sessions.set(row.id, {
            id: row.id,
            threadId: row.id,
            agentId: 'codex',
            title: cleanTitle || `Codex (${basename(row.cwd || this.defaultProjectPath)})`,
            projectPath: row.cwd || this.defaultProjectPath,
            status: 'idle',
            createdAt: createdIso,
            updatedAt: updatedIso,
          });
        }
      } catch {
        // Ignore sqlite read errors
      }
    }
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const nowIso = new Date().toISOString();
    const record: CodexSessionRecord = {
      id: `codex_ses_${randomUUID()}`,
      agentId: 'codex',
      title: input.title?.trim() || 'Codex Session',
      projectPath: input.projectPath?.trim() || this.defaultProjectPath,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(record.id, record);
    return this.toAgentSession(record);
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    if (this.discoverLocalHistory && !this.loadedHistoryThreads.has(sessionId)) {
      this.loadedHistoryThreads.add(sessionId);
      this.emitCodexThreadHistory(sessionId);
    }
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return this.toAgentSession(existing);
    }

    const nowIso = new Date().toISOString();
    const resumed: CodexSessionRecord = {
      id: sessionId,
      threadId: sessionId,
      agentId: 'codex',
      title: `Codex Thread ${sessionId.slice(0, 8)}`,
      projectPath: this.defaultProjectPath,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(sessionId, resumed);
    return this.toAgentSession(resumed);
  }

  private emitCodexThreadHistory(sessionId: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return;
    const codexDir = join(homedir(), '.codex');
    const historyDb = resolveLatestVersionedSqlite(codexDir, 'thread_history');
    if (!historyDb) return;

    try {
      // 增量回放：按 itemId + 已回放长度补发缺失后缀，幂等且捕获内容更新。
      // eventId 稳定（history:sid:item:rev），配合客户端 eventId 去重。
      const pageSize = 200;
      // 完整分页，不硬上限静默截断
      const maxRows = 20000;
      let totalRead = 0;
      for (let offset = 0; ; offset += pageSize) {
        const sql = `SELECT item_id, item_type, item_json, created_at_ms FROM thread_items WHERE thread_id = '${sessionId}' ORDER BY rollout_ordinal ASC LIMIT ${offset}, ${pageSize};`;
        const out = execFileSync('sqlite3', ['-json', historyDb, sql], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const rows = JSON.parse(out || '[]') as Array<{
          item_id?: string;
          item_type?: string;
          item_json?: string;
          created_at_ms?: number;
        }>;
        if (rows.length === 0) break;
        totalRead += rows.length;

        for (const row of rows) {
          if (!row.item_json) continue;
          const itemId = row.item_id ?? '';
          try {
            const item = JSON.parse(row.item_json) as {
              id?: string;
              type?: string;
              text?: string;
              command?: string;
              aggregated_output?: string;
              exit_code?: number;
              content?: Array<{ type?: string; text?: string }>;
            };
            const ts = row.created_at_ms
              ? new Date(row.created_at_ms).toISOString()
              : new Date().toISOString();

            if (row.item_type === 'userMessage') {
              const text = (item.content ?? []).map((c) => c.text ?? '').join('').trim();
              const emitted = this.emittedTextLength.get(itemId) ?? 0;
              if (text.length > emitted) {
                this.emittedTextLength.set(itemId, text.length);
                this.emitTextDelta(sessionId, itemId, text.length, text.slice(emitted), 'user', ts);
              }
            } else if (row.item_type === 'agentMessage' && item.text) {
              const text = item.text.trim();
              const emitted = this.emittedTextLength.get(itemId) ?? 0;
              if (text.length > emitted) {
                this.emittedTextLength.set(itemId, text.length);
                this.emitTextDelta(sessionId, itemId, text.length, text.slice(emitted), undefined, ts);
              }
            } else if (row.item_type === 'commandExecution' && item.command) {
              const callId = item.id || itemId || `cmd_${randomUUID()}`;
              // tool_use 只发一次
              if (!this.emittedToolUse.has(callId)) {
                this.emittedToolUse.add(callId);
                this.emitEvent(
                  createCanonicalEvent({
                    eventId: `history:${sessionId}:tool:${callId}`,
                    streamEpoch: this.normalizer.streamEpoch,
                    agentId: 'codex',
                    sessionId,
                    sequence: this.normalizer.nextSequence(sessionId),
                    timestamp: ts,
                    type: 'tool_use',
                    payload: { toolCallId: callId, name: 'bash', input: { command: item.command } },
                  }),
                );
              }
              // tool_result：发全量内容（手机端是覆盖语义，增量会导致只留后缀）
              const output = item.aggregated_output ?? '';
              const resultEmitted = this.emittedToolResultLength.get(callId) ?? -1;
              if (output.length > resultEmitted) {
                this.emittedToolResultLength.set(callId, output.length);
                const result = truncateOutput(output, DEFAULT_MAX_TOOL_OUTPUT_LENGTH);
                this.emitEvent(
                  createCanonicalEvent({
                    eventId: `history:${sessionId}:tool:${callId}:result:${output.length}`,
                    streamEpoch: this.normalizer.streamEpoch,
                    agentId: 'codex',
                    sessionId,
                    sequence: this.normalizer.nextSequence(sessionId),
                    timestamp: ts,
                    type: 'tool_result',
                    payload: {
                      toolCallId: callId,
                      content: result.content,
                      isError: (item.exit_code ?? 0) !== 0,
                      truncated: result.truncated,
                    },
                  }),
                );
              }
            }
          } catch {
            // Ignore malformed item_json
          }
        }
        if (rows.length < pageSize) break;
        if (totalRead >= maxRows) {
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

  /** 暴露历史恢复诊断（供 Bridge /diagnostics 聚合）。 */
  getDiagnostics() {
    return {
      historyRecoveryErrors: [...this.historyRecoveryErrors],
    };
  }

  /** 回放文本增量：稳定 eventId + streamEpoch + partRevision，供客户端幂等去重。 */
  private emitTextDelta(
    sessionId: string,
    itemId: string,
    revision: number,
    delta: string,
    role: string | undefined,
    timestamp: string,
  ): void {
    this.emitEvent(
      createCanonicalEvent({
        eventId: `history:${sessionId}:${itemId}:${revision}`,
        streamEpoch: this.normalizer.streamEpoch,
        agentId: 'codex',
        sessionId,
        sequence: this.normalizer.nextSequence(sessionId),
        timestamp,
        type: 'text_delta',
        payload: { delta, partId: itemId, partRevision: revision, ...(role ? { role } : {}) },
      }),
    );
  }

  private emitEvent(event: CanonicalAgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    let record = this.sessions.get(sessionId);
    if (!record) {
      await this.loadSession(sessionId);
      record = this.sessions.get(sessionId)!;
    }

    const boundThreadId = record.threadId ?? this.normalizer.getThreadId(sessionId);
    const args: string[] = boundThreadId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', boundThreadId, message]
      : ['exec', '--json', '--skip-git-repo-check', '-C', record.projectPath, message];

    const proc = this.spawnProcessImpl(args, { cwd: record.projectPath });
    this.activeProcesses.set(sessionId, proc);
    record.status = 'running';
    record.updatedAt = new Date().toISOString();

    await new Promise<void>((resolve, reject) => {
      let buffer = '';

      proc.stdout.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          this.processJsonLine(sessionId, record!, line);
        }
      });

      proc.onError((error) => {
        this.activeProcesses.delete(sessionId);
        record!.status = 'failed';
        reject(error);
      });

      proc.onExit(() => {
        if (buffer.trim().length > 0) {
          this.processJsonLine(sessionId, record!, buffer);
          buffer = '';
        }
        this.activeProcesses.delete(sessionId);
        const normStatus = this.normalizer.getSessionStatus(sessionId);
        if (normStatus) {
          record!.status = normStatus;
        } else if (record!.status === 'running') {
          record!.status = 'idle';
        }
        record!.updatedAt = new Date().toISOString();
        resolve();
      });
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      proc.kill();
      this.activeProcesses.delete(sessionId);
    }
    const record = this.sessions.get(sessionId);
    if (record) {
      record.status = 'cancelled';
      record.updatedAt = new Date().toISOString();
    }
  }

  async dispose(): Promise<void> {
    for (const proc of this.activeProcesses.values()) {
      proc.kill();
    }
    this.activeProcesses.clear();
    this.listeners.clear();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private processJsonLine(
    sessionId: string,
    record: CodexSessionRecord,
    line: string,
  ): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    const events = this.normalizer.normalize(sessionId, parsed);
    const threadId = this.normalizer.getThreadId(sessionId);
    if (threadId) {
      record.threadId = threadId;
    }

    for (const event of events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  private toAgentSession(record: CodexSessionRecord): AgentSession {
    const status = this.normalizer.getSessionStatus(record.id) ?? record.status;
    return {
      id: record.id,
      agentId: 'codex',
      title: record.title,
      projectPath: record.projectPath,
      status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

function resolveCodexBinary(explicit?: string): string {
  if (explicit) return explicit;
  const home = homedir();
  const candidates = [
    join(home, '.bun/bin/codex'),
    join(home, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return 'codex';
}

function resolveLatestCodexStateDb(codexDir: string): string | undefined {
  return resolveLatestVersionedSqlite(codexDir, 'state');
}

function resolveLatestVersionedSqlite(
  codexDir: string,
  prefix: string,
): string | undefined {
  if (!existsSync(codexDir)) return undefined;
  const pattern = new RegExp(`^${prefix}(?:_(\\d+))?\\.sqlite$`);
  try {
    const candidates = readdirSync(codexDir)
      .filter((name) => pattern.test(name))
      .map((name) => {
        const fullPath = join(codexDir, name);
        const verMatch = name.match(pattern);
        const schemaVer = verMatch?.[1] ? Number(verMatch[1]) : 0;
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
          // Ignore stat error
        }
        return { fullPath, schemaVer, mtimeMs };
      })
      .sort((a, b) => b.schemaVer - a.schemaVer || b.mtimeMs - a.mtimeMs);
    return candidates[0]?.fullPath;
  } catch {
    return undefined;
  }
}

let cachedMacProxy: string | null | undefined;

function detectMacSystemProxyUrl(): string | undefined {
  if (cachedMacProxy !== undefined) {
    return cachedMacProxy ?? undefined;
  }
  if (process.platform !== 'darwin') {
    cachedMacProxy = null;
    return undefined;
  }
  try {
    const out = execFileSync('scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 800,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const enabled = /HTTPEnable\s*:\s*1/.test(out);
    const hostMatch = out.match(/HTTPProxy\s*:\s*([^\s\n]+)/);
    const portMatch = out.match(/HTTPPort\s*:\s*(\d+)/);
    if (enabled && hostMatch?.[1] && portMatch?.[1]) {
      cachedMacProxy = `http://${hostMatch[1]}:${portMatch[1]}`;
      return cachedMacProxy;
    }
  } catch {
    // Ignore scutil errors
  }
  cachedMacProxy = null;
  return undefined;
}

function buildCodexEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extraPaths = [
    join(home, '.bun/bin'),
    join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const currentPath = process.env.PATH ?? '';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...extraPaths, currentPath].filter(Boolean).join(':'),
  };

  if (!env.https_proxy && !env.HTTPS_PROXY && !env.http_proxy && !env.HTTP_PROXY) {
    const sysProxy = detectMacSystemProxyUrl();
    if (sysProxy) {
      env.http_proxy = sysProxy;
      env.https_proxy = sysProxy;
      env.HTTP_PROXY = sysProxy;
      env.HTTPS_PROXY = sysProxy;
    }
  }
  return env;
}
