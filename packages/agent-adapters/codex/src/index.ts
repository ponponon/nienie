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
  AgentStatus,
  CanonicalAgentEvent,
  CreateSessionInput,
} from '@nienie/protocol';
import { CodexEventNormalizer, type CodexNormalizerOptions } from './normalizer.js';
import {
  CodexSessionStore,
  type CodexSessionRunState,
  type CodexStoredSession,
} from './session-store.js';

export { CodexEventNormalizer, type CodexNormalizerOptions } from './normalizer.js';
export { CodexSessionStore, type CodexStoredSession, type CodexSessionStoreOptions } from './session-store.js';

/** Nienie 自己创建的会话 id 前缀——只有这类会话需要 Bridge 自己持久化。 */
const NIENIE_SESSION_ID_PREFIX = 'codex_ses_';

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
  /** R3-3：确认进程真正启动成功（Node 'spawn' 事件）。spawn 是异步确认，error 事件才暴露启动失败。 */
  onSpawn(listener: () => void): void;
};

export type CodexSpawnOptions = {
  cwd?: string | undefined;
};

export type CodexAdapterOptions = CodexNormalizerOptions & {
  executablePath?: string | undefined;
  defaultProjectPath?: string | undefined;
  /** Codex 数据目录，默认 `~/.codex`。测试可注入临时目录验证历史库读取。 */
  codexHome?: string | undefined;
  /**
   * 是否从 `~/.codex` 本地历史库发现会话。
   * 默认在没注入 `spawnProcess` / `detectVersion` 时启用；显式传入可覆盖（测试用）。
   */
  discoverLocalHistory?: boolean | undefined;
  detectVersion?: (() => Promise<string>) | undefined;
  spawnProcess?: ((args: string[], options: CodexSpawnOptions) => CodexProcessHandle) | undefined;
  /**
   * Nienie 自建会话的持久化文件路径。不传则只在内存里保留（Bridge 重启即丢）。
   * 路径应由 Bridge / Electron 注入，适配器不依赖任何 UI 层。
   */
  sessionStorePath?: string | undefined;
};

/**
 * Codex「用户可见会话」的来源过滤条件，与 codex-rs 的 `INTERACTIVE_SESSION_SOURCES`
 * （`codex-rs/core/src/rollout/mod.rs` = Cli / VSCode / Custom("atlas") / Custom("chatgpt")）逐字对齐。
 *
 * 用精确 `IN` 而不是 `LIKE '{"custom":%'`：官方把 Custom 序列化成 `{"custom":"<name>"}`，
 * 但白名单只包含这两个名字，放宽匹配会把未来的第三方 custom 来源（以及各种内部线程）又放进来。
 * 官方 state 层的过滤本身就是 `source IN (...)`（`codex-rs/state/src/runtime/threads.rs`）。
 *
 * state 库里混着很多 Codex UI 从不展示的线程：
 * - `{"subagent": ...}`：子 Agent / thread_spawn 线程（如 logo skill 的 logo_a/b/c）、guardian 复核线程；
 * - `exec`：`codex exec` 一次性执行线程（包括 Nienie 自己 spawn 的 run）；
 * - `mcp` / `{"internal": ...}` / `unknown`：MCP、内部与未知来源。
 * 不过滤就会在手机端冒出 Codex 里根本不存在的「幽灵会话」。
 */
const CODEX_INTERACTIVE_SOURCES = [
  'cli',
  'vscode',
  '{"custom":"atlas"}',
  '{"custom":"chatgpt"}',
] as const;

const CODEX_INTERACTIVE_SOURCES_SQL = `source IN (${CODEX_INTERACTIVE_SOURCES.map(
  (source) => `'${source}'`,
).join(', ')})`;

type CodexSessionRecord = AgentSession & {
  threadId?: string | undefined;
  /** 已确认该 threadId 在 Codex 侧不存在：仍保留作「最后已知身份」，但禁止再 resume。 */
  threadMissing?: boolean | undefined;
  /** 执行阶段：用于识别「spawn 后、threadId 落盘前」的崩溃窗口。 */
  runState?: CodexSessionRunState | undefined;
};

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly name = 'Codex';
  readonly capabilities = { ...capabilities };

  private readonly executablePath: string;
  private readonly defaultProjectPath: string;
  private readonly codexHome: string;
  private readonly detectVersionImpl: () => Promise<string>;
  private readonly spawnProcessImpl: (
    args: string[],
    options: CodexSpawnOptions,
  ) => CodexProcessHandle;
  private readonly normalizer: CodexEventNormalizer;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sessions = new Map<string, CodexSessionRecord>();
  private readonly activeProcesses = new Map<string, CodexProcessHandle>();
  /**
   * F5：Session 串行锁——sendMessage 入口同步加锁，直到**真实进程退出**（onExit）才释放。
   * cancel 不释放锁（kill≠已退出），封死「kill 后 exit 前双进程」窗口。
   */
  private readonly sessionLocks = new Set<string>();
  /** F5-1：取消意图——启动中被取消时阻止后续 spawn / 确认后立即 kill，但锁仍等真实退出。 */
  private readonly cancelRequested = new Set<string>();
  private readonly discoverLocalHistory: boolean;
  /** Nienie 自建会话的落盘索引（可选）。 */
  private readonly sessionStore: CodexSessionStore | undefined;
  /** 落盘索引路径（只用于诊断信息，不参与读写）。 */
  private readonly sessionStorePath: string | undefined;
  private storedSessionsLoaded = false;
  /** 加载失败后的重试时间点（成功即清空），避免每次 listSessions 都打一次磁盘。 */
  private storedSessionsRetryAt = 0;
  private storedSessionsRetryDelayMs = 1_000;
  private readonly loadedHistoryThreads = new Set<string>();
  /** 已确认存在于 Codex state 库的 threadId（避免每条消息都查一次 sqlite）。 */
  private readonly verifiedThreads = new Set<string>();
  private historyLoaded = false;
  /** 历史库暂不可用（未安装 / 还没建库）时的低频重试时间点。 */
  private historyRetryAt = 0;
  /** 历史库读取失败后的退避间隔（1s → 2s → 4s → … 上限 60s）。 */
  private historyRetryDelayMs = 1_000;
  /** 连续失败次数，只用于诊断，不用于「永久放弃」。 */
  private historyFailureCount = 0;
  private static readonly HISTORY_RETRY_MAX_MS = 60_000;
  private static readonly HISTORY_NOT_READY_RETRY_MS = 60_000;
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
    // 与 Codex 自己的约定一致：`CODEX_HOME` 覆盖默认的 `~/.codex`
    const envCodexHome = process.env.CODEX_HOME?.trim();
    this.codexHome = options.codexHome ?? (envCodexHome ? envCodexHome : join(homedir(), '.codex'));
    this.normalizer = new CodexEventNormalizer(options);
    this.discoverLocalHistory =
      options.discoverLocalHistory ?? (!options.spawnProcess && !options.detectVersion);
    this.sessionStorePath = options.sessionStorePath;
    this.sessionStore = options.sessionStorePath
      ? new CodexSessionStore({ filePath: options.sessionStorePath })
      : undefined;

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
          onSpawn(listener) {
            child.once('spawn', () => listener());
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
    this.ensureStoredSessionsLoaded();
    if (this.discoverLocalHistory && !this.historyLoaded && Date.now() >= this.historyRetryAt) {
      this.applyHistoryLoadResult(this.loadLocalCodexHistory());
    }
    return [...this.sessions.values()].map((record) => this.toAgentSession(record));
  }

  /**
   * 历史库读取结果：
   * - `loaded`：读到了（或者已经不需要再读）；
   * - `not-ready`：库还不存在（没装 Codex / 还没跑过），低频重试，等它出现；
   * - `failed`：读取报错（sqlite3 缺失 / schema 变化 / 库被锁），指数退避重试并写诊断。
   */
  private applyHistoryLoadResult(result: 'loaded' | 'not-ready' | 'failed'): void {
    if (result === 'loaded') {
      this.historyLoaded = true;
      this.historyRetryAt = 0;
      this.historyRetryDelayMs = 1_000;
      this.historyFailureCount = 0;
      return;
    }
    // 只给失败计数封顶（诊断用），永远不停止重试：Codex 可能稍后才安装 / 迁移完成
    this.historyFailureCount = Math.min(this.historyFailureCount + 1, 100);
    if (result === 'not-ready') {
      this.historyRetryAt = Date.now() + CodexAdapter.HISTORY_NOT_READY_RETRY_MS;
      return;
    }
    this.historyRetryAt = Date.now() + this.historyRetryDelayMs;
    this.historyRetryDelayMs = Math.min(
      this.historyRetryDelayMs * 2,
      CodexAdapter.HISTORY_RETRY_MAX_MS,
    );
  }

  private loadLocalCodexHistory(): 'loaded' | 'not-ready' | 'failed' {
    const sqlitePath = resolveLatestCodexStateDb(this.codexHome);
    // 没装 Codex 或还没跑过 → 不是失败，但要保留「稍后再看一眼」的机会
    if (!sqlitePath) return 'not-ready';
    try {
      // 只列 Codex UI 会展示的交互式会话（见 CODEX_INTERACTIVE_SOURCES_SQL）：
      // 子 Agent / guardian / exec 线程属于内部实现细节，不该出现在手机端的会话列表里。
      // 内容条件按 schema 版本探测（见 codexThreadContentFilter），老库不会因缺列整条查询报错。
      const contentFilter = codexThreadContentFilter(sqlitePath);
      const out = execFileSync(
        'sqlite3',
        [
          '-json',
          sqlitePath,
          `SELECT id, substr(title, 1, 80) AS title, cwd, created_at, updated_at FROM threads WHERE archived = 0 AND ${CODEX_INTERACTIVE_SOURCES_SQL}${contentFilter} ORDER BY updated_at DESC LIMIT 60;`,
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
      // 已知线程（含内存会话绑定的 threadId）不重复入列
      const knownThreadIds = new Set<string>();
      for (const record of this.sessions.values()) {
        if (record.threadId) knownThreadIds.add(record.threadId);
      }
      for (const row of rows) {
        if (!row.id || this.sessions.has(row.id) || knownThreadIds.has(row.id)) continue;
        const cleanTitle = (row.title ?? '').replace(/\s+/g, ' ').trim();
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
      return 'loaded';
    } catch (error) {
      // 不静默：sqlite3 缺失 / state 库 schema 变化都会让历史列表变空，必须能在 /diagnostics 里看到
      this.emitDiagnosticWarning(
        `codex history load failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
  }

  /**
   * 把 Nienie 自己持久化的会话装回内存（Bridge 重启后恢复）。
   *
   * 重启时进程都不在了：`running` / `starting` / `waiting` 一律降级成 `idle`，
   * 不能假装它还在跑（手机端会一直转圈等一个不存在的进程）。
   *
   * 标记只在**收敛**（采用成功 / 确认没有文件 / 成功隔离）后才置位：
   * 读失败、锁被别的实例占用、隔离失败都保留可重试状态，配合退避 1s → 60s。
   * 之前是「进来就置位」，一次临时错误就能让这个实例永远不再加载。
   */
  private ensureStoredSessionsLoaded(): void {
    if (!this.sessionStore || this.storedSessionsLoaded) return;
    const now = Date.now();
    if (now < this.storedSessionsRetryAt) return;
    if (this.loadStoredSessions()) {
      this.storedSessionsLoaded = true;
      this.storedSessionsRetryDelayMs = 1_000;
      return;
    }
    this.storedSessionsRetryAt = now + this.storedSessionsRetryDelayMs;
    this.storedSessionsRetryDelayMs = Math.min(this.storedSessionsRetryDelayMs * 2, 60_000);
  }

  /** 真正做一次加载。返回是否已收敛（true = 不必再试）。 */
  private loadStoredSessions(): boolean {
    const store = this.sessionStore!;
    let result: ReturnType<CodexSessionStore['load']>;
    try {
      result = store.load();
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex session store load failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (result.status === 'missing') return true;
    if (result.status === 'ok') {
      this.adoptStoredSessions(result.sessions);
      return true;
    }
    // 读不动 / 版本不认识：走 store 的锁内隔离——它会在临界区里**重新读一遍**再决定，
    // 如果另一个实例已经把文件修好并写入会话，这里直接采用最新内容，绝不把有效文件挪走。
    let recovery: ReturnType<CodexSessionStore['quarantineIfUnusable']>;
    try {
      recovery = store.quarantineIfUnusable();
    } catch (error) {
      // 抢不到写锁（另一个实例正在写）属于暂时状态：保留可重试，别把标记写成已加载
      this.emitDiagnosticWarning(
        `codex session store ${result.status}; quarantine skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (recovery.status === 'ok') {
      this.adoptStoredSessions(recovery.sessions);
      return true;
    }
    if (recovery.status === 'missing' || recovery.status === 'quarantined') {
      if (recovery.status === 'quarantined') {
        this.emitDiagnosticWarning(
          `codex session store ${recovery.reason}; old file quarantined to ${recovery.backupPath}`,
        );
      }
      return true;
    }
    // 隔离失败（目录只读等）→ 文件还在原地，save() 会 fail-closed 拒绝写入。
    // 用户修好权限后应能自动恢复，所以这里不置位终态，继续按退避重试。
    this.emitDiagnosticWarning(
      `codex session store ${recovery.reason}; quarantine FAILED, persistence disabled until ${this.sessionStorePath} is fixed manually`,
    );
    return false;
  }

  /** 把落盘会话装进内存（已存在的 id 不覆盖，内存状态更新）。 */
  private adoptStoredSessions(sessions: readonly CodexStoredSession[]): void {
    for (const session of sessions) {
      // 只认自己创建的会话，防止被篡改的文件塞入任意 threadId
      if (!session.id.startsWith(NIENIE_SESSION_ID_PREFIX) || this.sessions.has(session.id)) {
        continue;
      }
      const runState = restoreRunState(session);
      this.sessions.set(session.id, {
        id: session.id,
        ...(session.threadId ? { threadId: session.threadId } : {}),
        agentId: 'codex',
        title: session.title,
        projectPath: session.projectPath,
        status: restoreStatus(session.status, runState, session.threadId, session.threadMissing),
        runState,
        ...(session.threadMissing ? { threadMissing: true } : {}),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }
  }

  /**
   * 只落盘 Nienie 自己创建的会话；Codex 桌面端会话由 state 库负责，不做二次存储。
   * 返回是否真的写成功——关键状态（spawn 前的 starting）必须能据此阻止执行。
   */
  private persistOwnedSessions(): boolean {
    if (!this.sessionStore) return true;
    // 先恢复再写：否则「新建会话 → 立刻落盘」会把上一次运行存的会话整份覆盖掉
    this.ensureStoredSessionsLoaded();
    const owned = [...this.sessions.values()].filter((record) =>
      record.id.startsWith(NIENIE_SESSION_ID_PREFIX),
    );
    if (owned.length === 0) return true;
    try {
      this.sessionStore.save(
        owned.map((record) => ({
          id: record.id,
          ...(record.threadId ? { threadId: record.threadId } : {}),
          ...(record.threadMissing ? { threadMissing: true } : {}),
          title: record.title,
          projectPath: record.projectPath,
          status: record.status,
          ...(record.runState ? { runState: record.runState } : {}),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })),
      );
      return true;
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex session store save failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const nowIso = new Date().toISOString();
    const record: CodexSessionRecord = {
      id: `${NIENIE_SESSION_ID_PREFIX}${randomUUID()}`,
      agentId: 'codex',
      title: input.title?.trim() || 'Codex Session',
      projectPath: input.projectPath?.trim() || this.defaultProjectPath,
      status: 'idle',
      runState: 'never_started',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(record.id, record);
    // 创建即落盘：手机端点了「新建」就算数，不能等第一轮跑完（Bridge 中途重启也不丢）
    this.persistOwnedSessions();
    return this.toAgentSession(record);
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    this.ensureStoredSessionsLoaded();
    if (this.discoverLocalHistory && !this.loadedHistoryThreads.has(sessionId)) {
      // 内存会话的 id 是 Nienie 自己的（codex_ses_*），Codex 历史库按真实的 thread_id 建索引：
      // 查库用 threadId，事件仍归属 sessionId（否则手机端会收到挂错会话的消息）。
      const historyThreadId = this.sessions.get(sessionId)?.threadId ?? sessionId;
      // 只有真正回放成功才标记已加载：历史库还没落盘 / 暂时读失败时，下次打开会话要能重试
      if (this.emitCodexThreadHistory(sessionId, historyThreadId)) {
        this.loadedHistoryThreads.add(sessionId);
      }
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

  /**
   * 回放 Codex 历史。
   *
   * 两个 ID 必须分开：`sessionId` 是手机端看到的会话身份（内存会话形如 `codex_ses_*`），
   * `threadId` 是 Codex 历史库（`thread_history.thread_items.thread_id`）的索引键。
   * 用 threadId 查库、用 sessionId 发事件——否则回放出来的消息会挂到手机端不存在的会话上。
   */
  private emitCodexThreadHistory(sessionId: string, threadId: string = sessionId): boolean {
    if (!/^[A-Za-z0-9_-]+$/.test(threadId)) return false;
    const historyDb = resolveLatestVersionedSqlite(this.codexHome, 'thread_history');
    // 历史库还没生成（新会话首次运行前）属于「暂时没有」，下次打开再试
    if (!historyDb) return false;

    try {
      // 增量回放：按 itemId + 已回放长度补发缺失后缀，幂等且捕获内容更新。
      // eventId 稳定（history:sid:item:rev），配合客户端 eventId 去重。
      const pageSize = 200;
      // 完整分页，不硬上限静默截断
      const maxRows = 20000;
      let totalRead = 0;
      for (let offset = 0; ; offset += pageSize) {
        const sql = `SELECT item_id, item_type, item_json, created_at_ms FROM thread_items WHERE thread_id = '${threadId}' ORDER BY rollout_ordinal ASC LIMIT ${offset}, ${pageSize};`;
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
                    payload: {
                      toolCallId: callId,
                      name: 'bash',
                      input: { command: item.command },
                      // Round 4：历史库只有 created_at_ms——不是真实执行时间，禁止伪造耗时
                      timingKnown: false,
                    },
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
                      // Round 2：历史回放同样透传真实退出码（缺失不伪造）
                      ...(typeof item.exit_code === 'number'
                        ? { exitCode: item.exit_code }
                        : {}),
                      // Round 4：同上——历史时间不是执行起止时间
                      timingKnown: false,
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
      // 库在、但这个 thread 还没有任何记录：算「暂时没就绪」，别把已加载标记写死，
      // 否则 Codex 稍后落盘的消息永远不会被重新回放（代价只是下次打开多跑一次查询）
      if (totalRead === 0) return false;
      return true;
    } catch (error) {
      // 不静默：回放失败要让调用方知道（下次打开还能重试），也要能在 /diagnostics 里看到
      this.emitDiagnosticWarning(
        `codex history replay failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
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

  /** 各运行的后台执行 Promise（送达回执语义：sendMessage=接受即返回，执行用 waitForRun 等待） */
  private readonly runs = new Map<string, Promise<void>>();

  async sendMessage(sessionId: string, message: string): Promise<void> {
    // F5：同一 session 同一时刻只允许一个活动进程（单轮执行模型）。
    // 检查+加锁必须在任何 await 之前同步完成（否则 loadSession 的 await 窗口双 spawn）；
    // 锁直到真实进程退出（onExit）才释放（F5-2：kill≠已退出）
    if (this.sessionLocks.has(sessionId)) {
      throw new Error('会话已有运行中的任务，请等待完成或取消后再发送');
    }
    this.sessionLocks.add(sessionId);
    let record: CodexSessionRecord;
    let proc: CodexProcessHandle;
    try {
      record = this.sessions.get(sessionId)!;
      if (!record) {
        await this.loadSession(sessionId);
        record = this.sessions.get(sessionId)!;
      }

      // F5-1：启动中已被取消——不再 spawn
      if (this.cancelRequested.delete(sessionId)) {
        record.status = 'cancelled'; // F3-2：启动中取消也持久化 cancelled
        record.updatedAt = new Date().toISOString();
        this.sessionLocks.delete(sessionId);
        throw new Error('会话任务已取消');
      }

      let boundThreadId = record.threadId ?? this.normalizer.getThreadId(sessionId);
      // 恢复前先确认 Codex 那边这个线程还在：用户可能在 Codex 里删了线程、换过机器、
      // 库被重置过。拿一个不存在的 id 去 `exec resume` 只会让这一轮莫名其妙失败，
      // 而且用户以为「还能接着聊」。这里明确降级成新会话，并在时间线上留一条提示。
      let lostThreadId: string | undefined;
      if (boundThreadId) {
        const probe = this.probeThread(boundThreadId);
        if (probe === 'exists') {
          if (record.threadMissing) {
            // 反向：线程又回来了（用户在 Codex 侧重新同步 / 换回了原来的库）。
            // 之前的设计「不缓存『不存在』」就是为了这一天，所以这里必须真的恢复绑定，
            // 否则标记会一直是 true、每次发消息都重复「换新线程」。
            // 清除必须走显式操作：save() 不允许清除这条否定事实。
            if (this.clearThreadMissing(sessionId, boundThreadId)) {
              record.threadMissing = false;
              this.emitDiagnosticWarning(
                `codex thread ${boundThreadId} is back; resuming it for ${sessionId}`,
              );
            }
          }
        } else if (probe === 'missing') {
          lostThreadId = boundThreadId;
          // 先落「已确认失效」再谈别的：`save()` 不写这个标记（否则旧快照能把它贴到新线程上），
          // 所以必须在这里用显式操作写下去，而且要在下面的 `starting` 持久化**之前**完成——
          // 崩溃窗口的重启判定依赖它（见 restoreStatus）。
          if (!this.markThreadMissing(sessionId, boundThreadId)) {
            this.emitRunError(sessionId, '会话状态持久化失败，未启动 Codex 任务，请检查本地存储');
            throw new Error('会话状态持久化失败，未启动 Codex 任务，请检查本地存储');
          }
          boundThreadId = undefined;
          // 关键：**保留** threadId（最后已知身份）但打上失效标记并持久化。
          // 只解绑不落盘会让 store 的「threadId 只增不减」把死 id 又合并回来，
          // 于是「spawn 了新线程但还没拿到 id 就崩溃」重启后 threadId 仍在，
          // 崩溃窗口判定失效、被误降级成 idle（把之前修好的 P1-2 又破坏掉）。
          record.threadMissing = true;
          record.runState = 'never_started';
          this.emitDiagnosticWarning(
            `codex thread ${lostThreadId} no longer exists; starting a new thread for ${sessionId}`,
          );
        } else if (record.threadMissing) {
          // 查询失败（unknown）但已经确认过这个 id 不存在：**持久事实优先**，
          // 一次查询抖动不能把「上下文已经丢了」翻回「还能接着聊」。这里同样不复用死 id，
          // 只是不重复发提示——那条消息在确认失效时就发过了。
          boundThreadId = undefined;
          record.runState = 'never_started';
          this.emitDiagnosticWarning(
            `codex thread ${record.threadId} is known-missing but re-check failed; keeping degraded binding for ${sessionId}`,
          );
        }
        // probe === 'unknown' 且没有失效标记 → fail-open：照旧 resume，交给 Codex 自己判断
      }
      const args: string[] = boundThreadId
        ? ['exec', 'resume', '--json', '--skip-git-repo-check', boundThreadId, message]
        : ['exec', '--json', '--skip-git-repo-check', '-C', record.projectPath, message];

      // P1-2 崩溃窗口：spawn 之前就先落盘 starting。否则进程起来、Codex 还没吐出
      // thread.started 时电脑断电/崩溃，重启后这条记录仍是 never_started + 无 threadId，
      // 会被当成「没跑过」的空会话——用户以为消息没发出去，其实 Codex 侧可能已经在跑。
      // 先写 starting，重启时才能识别为「被中断」（见 restoreStatus）。
      // 这一笔是安全边界本身：没落盘成功就不许 spawn，否则整个保证失效。
      const previousRunState = record.runState;
      record.runState = 'starting';
      record.updatedAt = new Date().toISOString();
      if (!this.persistOwnedSessions()) {
        record.runState = previousRunState;
        record.status = 'failed';
        record.updatedAt = new Date().toISOString();
        this.emitRunError(sessionId, '会话状态持久化失败，未启动 Codex 任务，请检查本地存储');
        throw new Error('会话状态持久化失败，未启动 Codex 任务，请检查本地存储');
      }

      // 提示必须发在持久化**成功之后**：落盘失败时根本没 spawn，却先告诉用户「将新建线程」
      // 就是在讲未经证实的事。文案也只承诺「尝试」——新线程能不能起来要等 spawn 结果。
      if (lostThreadId) {
        this.emitSessionNotice(
          sessionId,
          'THREAD_LOST',
          `原 Codex 线程 ${lostThreadId} 已不存在，本次将尝试新建线程继续，之前的上下文无法恢复`,
        );
      }

      proc = this.spawnProcessImpl(args, { cwd: record.projectPath });
      this.activeProcesses.set(sessionId, proc);
    } catch (error) {
      this.sessionLocks.delete(sessionId); // spawn 前失败释放锁（无进程存活）
      throw error;
    }

    // R3-3：真正确认 spawn 成功才「已送达电脑」——spawn() 是异步确认，
    // 二进制不存在等失败在 error 事件才暴露，必须拒绝（假送达）而非静默成功
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        proc.onSpawn(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        proc.onError((error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      });
    } catch (error) {
      this.activeProcesses.delete(sessionId);
      this.sessionLocks.delete(sessionId);
      // F3-2：spawn 确认前被取消 → cancelled；否则 failed
      const wasCancelled = this.cancelRequested.delete(sessionId);
      record.status = wasCancelled ? 'cancelled' : 'failed';
      // spawn 都没成功 = Codex 那一侧没起过进程，runState 要退回去；
      // 停在 'starting' 会让下次启动把它当成「跑一半被打断」，语义不对。
      if (!record.threadId) record.runState = 'never_started';
      record.updatedAt = new Date().toISOString();
      // 内存里改了终态就必须落盘，否则重启后磁盘上还是 starting/running
      this.persistOwnedSessions();
      if (!wasCancelled) {
        this.emitRunError(
          sessionId,
          `Codex 启动失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }

    if (this.cancelRequested.has(sessionId)) {
      // F3-2：spawn 确认前已被取消——立即终止刚确认的进程，终态 cancelled，锁等真实退出释放
      record.status = 'cancelled';
      record.updatedAt = new Date().toISOString();
      proc.kill();
    } else {
      record.status = 'running';
      record.updatedAt = new Date().toISOString();
    }

    // 送达回执语义（路线图 3.3）：spawn 成功即「已送达电脑」，执行在后台继续；
    // 完成/失败经事件流上报，sendMessage 不等待整个 Agent 执行
    const run = new Promise<void>((resolve, reject) => {
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
        // F3-1：运行期失败必须持久化 failed（不能只改本地状态/发事件），
        // 且不能把 activeProcesses 删除伪装成取消路径——真正释放等 onExit
        record!.status = 'failed';
        record!.updatedAt = new Date().toISOString();
        this.emitRunError(
          sessionId,
          `Codex 运行失败: ${error instanceof Error ? error.message : String(error)}`,
        );
        reject(error);
      });

      proc.onExit((code) => {
        if (buffer.trim().length > 0) {
          this.processJsonLine(sessionId, record!, buffer);
          buffer = '';
        }
        this.activeProcesses.delete(sessionId);
        // F5-2：真实进程退出才释放串行锁
        this.sessionLocks.delete(sessionId);
        const wasCancelled =
          this.cancelRequested.delete(sessionId) || record!.status === 'cancelled';
        // R3-3/F3：非零退出码或信号终止（code=null，非主动取消）按失败处理并上报
        if (!wasCancelled && record!.status !== 'failed' && (code === null || code !== 0)) {
          record!.status = 'failed';
          record!.updatedAt = new Date().toISOString();
          this.persistOwnedSessions();
          this.emitRunError(
            sessionId,
            code === null ? 'Codex 进程被信号终止' : `Codex 异常退出（退出码 ${code}）`,
          );
          resolve();
          return;
        }
        if (!wasCancelled && record!.status !== 'failed') {
          const normStatus = this.normalizer.getSessionStatus(sessionId);
          if (normStatus) {
            record!.status = normStatus;
          } else if (record!.status === 'running') {
            record!.status = 'idle';
          }
          record!.updatedAt = new Date().toISOString();
          this.persistOwnedSessions();
        }
        resolve();
      });
    });
    this.runs.set(sessionId, run);
    void run.catch(() => undefined); // 错误已经由 emitRunError 事件上报
  }

  /** R3-3/F3：运行失败必须反馈到手机——错误事件 + 终态 status 事件（终止 Thinking 计时/置失败）。 */
  private emitRunError(sessionId: string, message: string): void {    const base = {
      streamEpoch: this.normalizer.streamEpoch,
      agentId: 'codex' as const,
      sessionId,
      timestamp: new Date().toISOString(),
    };
    this.emitEvent(
      createCanonicalEvent({
        ...base,
        eventId: `runerr:${sessionId}:${Date.now()}`,
        sequence: this.normalizer.nextSequence(sessionId),
        type: 'error',
        payload: { code: 'RUN_FAILED', message, retryable: true },
      }),
    );
    this.emitEvent(
      createCanonicalEvent({
        ...base,
        eventId: `runst:${sessionId}:${Date.now()}`,
        sequence: this.normalizer.nextSequence(sessionId),
        type: 'status',
        payload: { status: 'failed', detail: message },
      }),
    );
  }

  /**
   * 会话级提示：**不改状态**，只让手机端在时间线里看到一条卡片。
   *
   * 目前协议里唯一能承载自由文本的可见事件就是 `error`（手机端渲染成 ErrorCard），
   * 所以这里复用它，但用独立 code（THREAD_LOST 等）标明它不是执行失败。
   */
  private emitSessionNotice(sessionId: string, code: string, message: string): void {
    this.emitEvent(
      createCanonicalEvent({
        streamEpoch: this.normalizer.streamEpoch,
        agentId: 'codex',
        sessionId,
        timestamp: new Date().toISOString(),
        eventId: `notice:${sessionId}:${code}:${Date.now()}`,
        sequence: this.normalizer.nextSequence(sessionId),
        type: 'error',
        payload: { code, message, retryable: false },
      }),
    );
  }

  /**
   * 这个 Codex 线程现在还存不存在？三种答案，不能压成布尔：
   *
   * - `exists`：查询成功且查到这一行（或本进程亲眼见过 `thread.started`）；
   * - `missing`：查询成功但没有这一行（用户删了线程 / 换机器 / 库被重置）；
   * - `unknown`：查不了（state 库不存在、`sqlite3` 缺失、SQL 报错）——**按存在处理**（fail-open），
   *   宁可照旧 resume 让 Codex 自己报错，也不能因为一次抖动就把用户的上下文判死刑。
   *
   * 两个方向的降级动作对答案的要求不对称，所以必须分开：
   * 「判死刑」（开新线程）只接受确定性的 `missing`；
   * 「恢复失效标记」要求确凿的 `exists`，`unknown` 不足以证明线程回来了。
   * `verifiedThreads` 只缓存肯定答案，不缓存 `missing`（线程可能被同步回来）。
   */
  private probeThread(threadId: string): 'exists' | 'missing' | 'unknown' {
    if (this.verifiedThreads.has(threadId)) return 'exists';
    // 格式非法 = 这个 id 不可能存在于 threads 表，属于确定性结论
    if (!/^[A-Za-z0-9_-]+$/.test(threadId)) return 'missing';
    const sqlitePath = resolveLatestCodexStateDb(this.codexHome);
    if (!sqlitePath) return 'unknown';
    try {
      const out = execFileSync(
        'sqlite3',
        ['-json', sqlitePath, `SELECT id FROM threads WHERE id = '${threadId}' LIMIT 1;`],
        { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const rows = JSON.parse(out || '[]') as unknown[];
      if (rows.length === 0) return 'missing';
      this.verifiedThreads.add(threadId);
      return 'exists';
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex thread check failed for ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'unknown';
    }
  }

  /**
   * 显式落「这个线程已确认不存在」的标记。
   *
   * 为什么不能交给 `persistOwnedSessions()`：`save()` 不接受内存里的 `threadMissing=true`
   * （另一个实例的旧快照也带着旧线程的 true，会把活着的线程判死），所以标记只能由
   * store 的显式操作写入。
   *
   * 返回 false = 存储不可用，调用方必须中止这一轮：写不进这个标记，
   * 「spawn 后、thread.started 前崩溃」的重启判定就重新失去依据。
   */
  private markThreadMissing(sessionId: string, threadId: string): boolean {
    if (!this.sessionStore) return true;
    try {
      // 返回 false 只表示「无需写」（记录不在盘上 / 已被别人换绑成新线程），不是失败
      this.sessionStore.markThreadMissing(sessionId, threadId);
      return true;
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex session mark thread missing failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * 线程重新出现后恢复绑定：清掉 `threadMissing`，**必须**走 store 的显式操作——
   * `save()` 不允许清除这条否定事实（否则另一个实例的旧快照会把它覆盖掉）。
   * 返回是否已在磁盘上确认恢复。
   */
  private clearThreadMissing(sessionId: string, threadId: string): boolean {
    if (!this.sessionStore) return true;
    try {
      return this.sessionStore.confirmThreadPresent(sessionId, threadId);
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex session thread restore failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /// 等待某会话当前运行完成（测试与诊断用；sendMessage 本身不等待执行）
  async waitForRun(sessionId: string): Promise<void> {    await this.runs.get(sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    // F5-1：cancel 不释放锁/占位——kill≠已退出，锁由 onExit 真实退出释放，封死双进程窗口
    if (!this.sessionLocks.has(sessionId)) return;
    this.cancelRequested.add(sessionId);
    // F3-2：启动中（spawn 确认前）或运行中被取消——都持久化 cancelled
    const record = this.sessions.get(sessionId);
    if (record && record.status !== 'failed') {
      record.status = 'cancelled';
      record.updatedAt = new Date().toISOString();
      this.persistOwnedSessions();
    }
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      proc.kill(); // 不删除 activeProcesses——onExit 统一释放
    }
  }

  async dispose(): Promise<void> {
    this.persistOwnedSessions();
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
    if (threadId && record.threadId !== threadId) {
      record.threadId = threadId;
      // 绑定到新线程 = 失效标记解除（旧线程的 id 已经被更可信的新身份取代）
      record.threadMissing = false;
      record.runState = 'started';
      // 本进程亲眼看到 thread.started：它就是存在的，不必再查库（见 probeThread）
      this.verifiedThreads.add(threadId);
      // 身份变更必须走 store 的显式操作：save() 只会「补空」，不会改写磁盘上已有的身份
      // （否则另一个实例的旧快照能把新线程 id 换回去）。显式换绑成功后再落盘其余字段。
      if (this.sessionStore) {
        try {
          this.sessionStore.bindThreadId(sessionId, threadId);
        } catch (error) {
          this.emitDiagnosticWarning(
            `codex session bind failed for ${sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      // 真实 threadId 一到就落盘：重启后靠它 resume + 回放历史
      this.persistOwnedSessions();
    }

    for (const event of events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  private toAgentSession(record: CodexSessionRecord): AgentSession {
    // F3：record 的终态（failed/cancelled）优先——normalizer 的旧 running 不得遮蔽失败结果
    const status =
      record.status === 'failed' || record.status === 'cancelled'
        ? record.status
        : this.normalizer.getSessionStatus(record.id) ?? record.status;
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

/** 首版文件没有 runState：按是否有 threadId 推断。 */
function restoreRunState(session: CodexStoredSession): CodexSessionRunState {
  return session.runState ?? (session.threadId ? 'started' : 'never_started');
}

/**
 * 重启后恢复状态：
 * - `running` / `starting` / `waiting` 一律降级 `idle`（进程已经不存在，不能伪装还在跑）；
 * - 但「spawn 已发生、threadId 还没落盘」的会话是**中断**：再发消息会新建一个线程、
 *   悄悄丢掉原上下文，所以标记为 `failed`，让手机端看到「这一轮被打断了」。
 */
function restoreStatus(
  status: AgentStatus,
  runState: CodexSessionRunState,
  threadId: string | undefined,
  threadMissing: boolean | undefined,
): AgentStatus {
  // 「跑了一半被打断」= 正在启动、但手里没有**可用的** threadId。
  // threadMissing 也算没有：那句话是真的（线程已不存在），新线程的 id 在崩溃前没拿到。
  const interrupted = runState === 'starting' && (!threadId || threadMissing === true);
  if (interrupted) return 'failed';
  return status === 'running' || status === 'starting' || status === 'waiting' ? 'idle' : status;
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

/**
 * 读取某张表的列名，用于按 schema 版本降级拼 SQL。
 *
 * 异常必须向外传播：`PRAGMA` 成功返回空集合表示「确实没有这些列」，可以降级；
 * 而 `sqlite3` 不存在 / 库被锁 / 文件不是 SQLite 属于读取失败，不能当成「没有这些列」，
 * 否则会紧接着再跑一次注定失败的主查询，还把一个真实的错误伪装成正常降级。
 */
function readTableColumns(sqlitePath: string, table: string): Set<string> {
  const out = execFileSync('sqlite3', ['-json', sqlitePath, `PRAGMA table_info(${table});`], {
    encoding: 'utf8',
    timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const columns = JSON.parse(out || '[]') as Array<{ name?: string }>;
  return new Set(
    columns.map((column) => column.name).filter((name): name is string => Boolean(name)),
  );
}

/**
 * Codex 自己的会话列表还要求「线程有可见的预览内容」
 * （`codex-rs/state/src/runtime/threads.rs` 的 `push_thread_filters`：`preview <> ''`；
 * 老版本用 `first_user_message <> ''`，`0032_threads_preview` 迁移后才改用 preview）。
 *
 * 列名随 schema 版本变化，直接写死会让老库整条查询报错、历史列表整体变空，
 * 所以先 PRAGMA 探测，再在**固定片段**里选一个拼上去（不接受任何外部输入）。
 */
function codexThreadContentFilter(sqlitePath: string): string {
  const columns = readTableColumns(sqlitePath, 'threads');
  if (columns.has('preview')) return " AND preview <> ''";
  if (columns.has('first_user_message')) return " AND first_user_message <> ''";
  return '';
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
