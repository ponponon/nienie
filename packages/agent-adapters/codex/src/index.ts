import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  isRunOwnerAlive,
  withFileWriteLock,
  type CodexBeginRunResult,
  type CodexBindingRead,
  type CodexExpectedBinding,
  type CodexSessionRunState,
  type CodexStoredSession,
} from './session-store.js';

export { CodexEventNormalizer, type CodexNormalizerOptions } from './normalizer.js';
export {
  CodexSessionStore,
  isRunOwnerAlive,
  type CodexBeginRunResult,
  type CodexBindingRead,
  type CodexBindingResult,
  type CodexCommitRunResult,
  type CodexExpectedBinding,
  type CodexFinishRunResult,
  type CodexSessionRunState,
  type CodexSessionStoreLoad,
  type CodexSessionStoreOptions,
  type CodexSessionStoreQuarantine,
  type CodexSetStatusResult,
  type CodexStoredBinding,
  type CodexStoredSession,
} from './session-store.js';

/** Nienie 自己创建的会话 id 前缀——只有这类会话需要 Bridge 自己持久化。 */
const NIENIE_SESSION_ID_PREFIX = 'codex_ses_';

/** sidecar（`<store>.stale-outcomes`）里的一条「终态没写进索引」记录。 */
type StaleOutcomeEntry = {
  /** 稳定标识：写入时生成，claim/归还/收编全程保留，事件 eventId 从它派生（客户端可幂等去重）。 */
  noticeId: string;
  sessionId: string;
  at: string;
  message: string;
};

/**
 * 进程内活跃的 claim 实例标识（`claimOwnerId`）。
 *
 * 孤儿收编不能只看 pid：**进程活着 ≠ 实例活着**——同进程的 Adapter 重建后，
 * 旧实例 dispose 归还失败残留的 claim 文件持有本进程 pid，只认 pid 会把它
 * 当成「活人不抢」永久滞留。实例标识在构造时注册、dispose 时注销；扫描时
 * 本进程 pid 下只跳过仍活跃实例的 claim，死实例的残留可被新实例收编。
 */
const activeClaimOwners = new Set<string>();

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
  /**
   * 进程收尾点：**进程已退出且 stdio 已关闭**之后才触发（Node `close` 的语义，不是 `exit`）。
   *
   * 为什么不能用 `exit`：`exit` 不保证 stdout 交付完毕——`thread.started` 可能还在
   * 管道里、比 `exit` 晚到。收尾（最终重试 + 终态写入）必须等所有输出都处理完，
   * 否则最终重试会早于最后一条数据，Codex 侧已建好的线程照样丢。
   */
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
  /**
   * 本实例的执行归属标识（写进 `runOwner`），默认 `${pid}@${hostname}`。
   *
   * 重启后的崩溃判定靠它区分「这一轮真的没人跑了」和「另一个 Bridge 还在跑」：
   * 归属进程活着就不许把状态断言成 failed。测试注入一个异主机标识即可模拟
   * 「上一个实例已经不在了」（跨主机无法验证存活，按没跑处理）。
   */
  ownerId?: string | undefined;
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
  /**
   * 磁盘上的身份修订号（本进程见到的最新值）。
   *
   * 换绑 CAS 用它而不是 `threadId`：线程可能 `missing → 恢复 → 又 missing`，两次看到的 id
   * 一模一样，中间却已经被别的实例改过一轮。修订号单调递增，不会漏掉这种并发。
   */
  bindingRevision?: number | undefined;
  /** 记录生成代（磁盘权威绑定里的 epoch），CAS 同时比较它——防「记录被删后重建」的 ABA。 */
  bindingEpoch?: string | undefined;
  /** 执行阶段：用于识别「spawn 后、threadId 落盘前」的崩溃窗口。 */
  runState?: CodexSessionRunState | undefined;
  /** 本轮执行的 fencing token（`beginRun` 发的）：收尾写入靠它证明「就是那一轮」。 */
  runAttempt?: string | undefined;
  /** 本轮执行归属（`${pid}@${host}`），重启后据此判断「是不是真的没人跑了」。 */
  runOwner?: string | undefined;
};

/**
 * 一轮执行的上下文：`beginRun` 那次成功写入产生的标识，贯穿 spawn → thread.started → 退出。
 *
 * `attempt` 是 fencing token（收尾写入靠它证明「就是那一轮」）；
 * `revision` 是**那次写入校验过**的身份修订号（换绑 CAS 用它）——两者都不能事后重新读盘取
 * 「最新值」，那可能是别的实例刚推进的，认领它就等于借用了别人的 fencing token。
 */
type CodexRunContext = {
  attempt: string;
  revision: number;
  /** thread.started 是否已经处理过：失败过一次就不再逐行重试写盘。 */
  threadStartedHandled: boolean;
  /**
   * 本轮收到但**还没落盘**的 threadId。
   *
   * `thread.started` 落盘失败（锁被占等）时留在这，退出收尾前再试最后一次——
   * 下一条 JSON 事件不一定会来，只靠逐行重试可能永远等不到，Codex 侧已经建好的
   * 线程就没有任何记录指向它了（幽灵线程的镜像：任务跑完了，身份却丢了）。
   */
  pendingThreadId?: string | undefined;
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
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => unknown>();
  private readonly sessions = new Map<string, CodexSessionRecord>();
  private readonly activeProcesses = new Map<string, CodexProcessHandle>();
  /**
   * 落盘失败的执行终态（cancel / dispose / 运行期 error / 退出收尾写不进去时挂起）。
   *
   * 终态写入失败**不许声称 attempt 已结束**：本地状态不推进，patch 留在这，
   * 收尾点（进程真正退出、锁释放后）重试补交（`drainPendingRunOutcome`）。
   * 否则内存是 cancelled、磁盘还是 starting + runOwner，别的 Bridge 会把
   * 已取消的任务显示成 running，身份操作也被在飞保护永久挡死。
   */
  private readonly pendingRunOutcomes = new Map<
    string,
    {
      attempt: string | undefined;
      patch: {
        status: AgentStatus;
        runState?: Exclude<CodexSessionRunState, 'starting'> | undefined;
      };
    }
  >();
  /**
   * 挂起终态的补交定时器与计数（每会话一个，避免叠跑）。
   *
   * **重试预算绑定 attempt**：新 attempt 覆盖旧 pending 时旧定时器/计数必须清掉，
   * 定时器回调也要核对自己捕获的 attempt 还是不是当前 pending 的——否则旧轮次
   * 遗留的定时器会去点新轮次的重试计数，把新轮次的预算提前烧光直接 give-up。
   */
  private readonly pendingRetryTimers = new Map<
    string,
    { attempt: string | undefined; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly pendingRetryCounts = new Map<string, { attempt: string | undefined; count: number }>();
  /** 运行期失败意图的挂起队列（store 无法确认归属时先挂着，确认后才登记/发事件）。 */
  private readonly pendingRunFailures = new Map<
    string,
    {
      attempt: string | undefined;
      error: unknown;
      retries: number;
      apply: () => void;
      defer: () => void;
    }
  >();
  private readonly runFailureConfirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 上一个实例放弃的终态提示（sidecar 领取后的待发队列；送达监听器后才删领取副本）。
   *
   * `event` 在领取解析时**只构建一次**：重发复用同一个事件（同 eventId / sequence），
   * 否则每次未送达的重试都烧掉一个新 sequence，客户端 replay 会把假的序号空洞
   * 当成缓存截断；同 eventId 也让客户端幂等去重有据可依。
   */
  private pendingStaleNotices: Array<{
    sessionId: string | undefined;
    message: string;
    event: CanonicalAgentEvent;
  }> = [];
  /**
   * 已摄取过的 sidecar 记录 `noticeId`（写入时生成的稳定标识）。
   *
   * 崩溃恢复后同一条记录可能同时存在于共享 sidecar 与未删掉的 claim 副本里
   * （append 成功、删 claim 前崩溃）——两份都会被摄取，按 noticeId 去重后
   * 只入队/送达一次。投递语义是 at-least-once + 稳定 ID 幂等。
   */
  private readonly seenNoticeIds = new Set<string>();
  /**
   * 含损坏行的 claim 副本：不静默删唯一副本，送达后隔离改名 `.corrupt` 保留证据。
   * 「全部是已摄取重复记录」才允许直接删——两种情况不能混为一谈。
   */
  private readonly corruptClaims = new Set<string>();
  /**
   * 通知意图的待写队列：give-up 的 sidecar append 失败时不许把意图丢掉——
   * 定时补写（锁释放后自动恢复），dispose 做最后一次补写，仍写不进则落成本
   * 实例名下的 claim 文件（dispose 注销实例后可被孤儿机制收编，不丢）。
   */
  private readonly pendingNoticeWrites = new Map<
    string,
    {
      entry: StaleOutcomeEntry;
      attempts: number;
      timer?: ReturnType<typeof setTimeout>;
      /** 已落盘的兜底 claim 路径（存在 = 通知已持久化，append 只是更优的送达路径）。 */
      fallbackPath?: string;
    }
  >();
  /** 本实例已领取（rename 到手）的 sidecar 副本；全部送达后才删除。 */
  private readonly claimedStaleFiles: string[] = [];
  /**
   * 本 Adapter 实例的领取文件名标识。
   *
   * 同一进程里可以有多个 Adapter 实例（测试、重建），只靠 pid 时它们会生成同名
   * claim 文件——`renameSync` 静默覆盖目的地，后领的批次把先领的批次顶掉（提示丢失）
   * 或共用一个删除入口（把对方未确认的副本删掉）。claim 文件名必须跨实例唯一。
   * 它同时是实例生命周期标识（见 `activeClaimOwners`）：进程活着 ≠ 实例活着。
   */
  private readonly claimOwnerId = randomUUID();
  private staleClaimSeq = 0;
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
  /** 本实例的执行归属标识，写进 `runOwner`（见 `CodexAdapterOptions.ownerId`）。 */
  private readonly ownerId: string;
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
    activeClaimOwners.add(this.claimOwnerId);
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
    this.ownerId = options.ownerId ?? `${process.pid}@${hostname()}`;
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
            // close = 进程已退出 且 stdio 已关闭：收尾（最终重试/终态写入）才能
            // 排在最后一条 stdout 数据之后。exit 可能先于数据交付，会把重试排在
            // pendingThreadId 填好之前，线程 ID 照样丢。
            child.once('close', (code) => listener(code));
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
    this.flushStaleOutcomeNotices();
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
        status: restoreStatus(session.status, runState, session.runOwner),
        runState,
        ...(session.threadMissing ? { threadMissing: true } : {}),
        ...(typeof session.bindingRevision === 'number'
          ? { bindingRevision: session.bindingRevision }
          : {}),
        ...(session.runAttempt ? { runAttempt: session.runAttempt } : {}),
        ...(session.runOwner ? { runOwner: session.runOwner } : {}),
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
          ...(typeof record.bindingRevision === 'number'
            ? { bindingRevision: record.bindingRevision }
            : {}),
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

  /**
   * 一轮执行的终态写回磁盘：**带 attempt 的 fencing 写入**（`finishRun`，它同时清掉
   * `runOwner`——「执行还活着」从此为假）。
   *
   * 迟到的旧执行会被 `stale-attempt` 挡住，而且**本地状态也不许推进**：这一轮已经不是
   * 主人，把它的失败写进本地记录会让自己的会话列表显示成失败（`toAgentSession` 对 failed
   * 优先），冒充当前 attempt 的终态。返回 `'stale'` 让调用方决定要不要发事件——过期执行的
   * 失败不冒充当前轮的失败。
   *
   * **落盘失败不许声称成功**：`finishRun` 抛错（锁被占等）时返回 `'persist-failed'`，
   * 本地状态同样不推进，patch 挂进 `pendingRunOutcomes` 等收尾点重试。
   * 返回 `'applied'` 却没写进磁盘，会让内存说 cancelled、磁盘还停在 starting + runOwner——
   * 别的 Bridge 重启后把已取消的任务显示成 running，身份操作也被在飞保护永久挡死。
   */
  private persistRunOutcome(
    sessionId: string,
    record: CodexSessionRecord,
    attempt: string | undefined,
    patch: { status: AgentStatus; runState?: Exclude<CodexSessionRunState, 'starting'> | undefined },
  ): 'applied' | 'stale' | 'persist-failed' | 'not-found' {
    const updatedAt = new Date().toISOString();
    const runState: Exclude<CodexSessionRunState, 'starting'> =
      patch.runState ?? (record.threadId ? 'started' : 'never_started');
    if (!this.sessionStore || !this.isOwnedSession(sessionId) || !attempt) {
      record.status = patch.status;
      record.runState = runState;
      record.updatedAt = updatedAt;
      this.persistOwnedSessions();
      return 'applied';
    }
    try {
      const result = this.sessionStore.finishRun(
        sessionId,
        { attempt },
        {
          status: patch.status,
          runState,
          updatedAt,
        },
      );
      if (result === 'stale-attempt') {
        this.emitDiagnosticWarning(
          `codex session ${sessionId}: stale run outcome ignored (attempt already replaced)`,
        );
        return 'stale';
      }
      if (result === 'not-found') {
        // 记录被别的实例删了：本地照常收尾（展示不能卡在 running），但绝不谎称写盘成功。
        // 重试也不可能找回（索引里已无此记录），同 attempt 的挂起一并清掉，避免收尾误报。
        this.emitDiagnosticWarning(
          `codex session ${sessionId}: run outcome not persisted (record missing from index)`,
        );
        record.status = patch.status;
        record.runState = runState;
        record.updatedAt = updatedAt;
        const pending = this.pendingRunOutcomes.get(sessionId);
        if (pending?.attempt === attempt) this.pendingRunOutcomes.delete(sessionId);
        return 'not-found';
      }
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex session run outcome persist failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.stashPendingRunOutcome(sessionId, attempt, patch);
      this.schedulePendingRetry(sessionId);
      return 'persist-failed';
    }
    record.status = patch.status;
    record.runState = runState;
    record.updatedAt = updatedAt;
    // 真正写进去了：同一个 attempt 的挂起终态（更早的失败留下的）已经过时，清掉，
    // 否则收尾告警会对着一份已经落盘的终态误报「未持久化」
    const pending = this.pendingRunOutcomes.get(sessionId);
    if (pending?.attempt === attempt) this.pendingRunOutcomes.delete(sessionId);
    return 'applied';
  }

  /**
   * 挂起一次没写进磁盘的终态（单槽：同一会话只留最后一次写入意图，apply 时仍被
   * `finishRun` 的 attempt fencing 拦截旧轮次）。
   *
   * **「用户取消」不可翻案成「执行失败」**由调用方守卫保证，不靠这里的排名：
   * dispose 记入 `cancelRequested`、onError 的取消守卫、close 后迟到 error 的
   * `runClosed` 忽略——三者把降级写入的路径都封死了（排名守卫在它们面前不可达，
   * 留着只会变成测不到的死代码）。
   */
  private stashPendingRunOutcome(
    sessionId: string,
    attempt: string | undefined,
    patch: {
      status: AgentStatus;
      runState?: Exclude<CodexSessionRunState, 'starting'> | undefined;
    },
  ): void {
    const existing = this.pendingRunOutcomes.get(sessionId);
    if (existing && existing.attempt !== attempt) {
      // 新 attempt 顶掉旧 pending：旧轮次的定时器与计数一并作废，
      // 不许旧定时器来点新轮次的重试计数（预算按 attempt 隔离）
      const timer = this.pendingRetryTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer.timer);
        this.pendingRetryTimers.delete(sessionId);
      }
      this.pendingRetryCounts.delete(sessionId);
    }
    this.pendingRunOutcomes.set(sessionId, { attempt, patch });
  }

  /**
   * 挂起终态的补交重试：写锁通常只被占很短，收尾点没赶上就定时再试几次（50ms × 5）。
   *
   * **重试次数只由这里的回调裁决**：`drainPendingRunOutcome` 内部的失败路径会顺手
   * 再排一次重试（谁失败谁重试），所以放弃时必须把那条刚排上的定时器一并清掉——
   * 否则「第 5 次放弃」之后第 6 次照跑、计数还被清零，实际是无限重试。
   */
  private schedulePendingRetry(sessionId: string): void {
    const pendingAttempt = this.pendingRunOutcomes.get(sessionId)?.attempt;
    if (this.pendingRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.pendingRetryTimers.delete(sessionId);
      // 定时器是按某一轮 attempt 排的：pending 已经换成别的 attempt 就地退出，
      // 不给新轮次的预算记账
      if (this.pendingRunOutcomes.get(sessionId)?.attempt !== pendingAttempt) return;
      const result = this.drainPendingRunOutcome(sessionId);
      if (result === 'persist-failed') {
        const count = (this.pendingRetryCounts.get(sessionId)?.count ?? 0) + 1;
        this.pendingRetryCounts.set(sessionId, { attempt: pendingAttempt, count });
        if (count >= 5) {
          this.pendingRetryCounts.delete(sessionId);
          // 放弃就是放弃：清掉 drain 失败路径刚排上的下一次重试，链子到此为止
          const next = this.pendingRetryTimers.get(sessionId);
          if (next) {
            clearTimeout(next.timer);
            this.pendingRetryTimers.delete(sessionId);
          }
          this.emitDiagnosticWarning(
            `codex session ${sessionId}: pending run outcome still unpersisted after retries; giving up`,
          );
          // 最终失败必须跨 Adapter 生命周期可见：dispose/换新实例后旧监听器已没了，
          // 只活在内存里的诊断没人看得见。
          this.persistStaleOutcomeNotice(sessionId);
          return;
        }
        this.schedulePendingRetry(sessionId);
        return;
      }
      this.pendingRetryCounts.delete(sessionId);
    }, 50);
    timer.unref?.();
    this.pendingRetryTimers.set(sessionId, { attempt: pendingAttempt, timer });
  }

  /**
   * 终态最终写不进磁盘的记录落盘（sidecar），供下一个 Adapter 加载后展示。
   *
   * append 与 claim 的 rename 共用 sidecar 锁：打开的 fd 一旦被 rename 带走，
   * 这条字节就写进别人的 claim 副本、随副本一起删掉——记到最后的提示不能这样消失。
   *
   * **append 失败不丢通知意图**：进待写队列定时补写（锁释放后自动恢复）；
   * 到限由**独立 finalizer**（重试链自己）落成 claim 兜底——dispose 之后才产生的
   * 晚到通知（onExit 收尾、补交链的 give-up）没有第二次 dispose 可指望，兜底
   * 必须在通知自己的收尾链里完成。共享池与 claim 文件都写不动才如实报 LOST。
   */
  private persistStaleOutcomeNotice(sessionId: string): void {
    if (!this.sessionStorePath) return;
    const entry: StaleOutcomeEntry = {
      noticeId: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      message: `codex session ${sessionId}: 终态最终未能写入本地索引（重试已放弃），其他窗口可能仍把它显示成运行中`,
    };
    if (this.writeStaleOutcomeEntry(entry)) return;
    // append 失败：意图进队列等补写，绝不就此丢掉
    const existing = this.pendingNoticeWrites.get(sessionId);
    if (existing?.timer) clearTimeout(existing.timer);
    this.pendingNoticeWrites.set(sessionId, { entry, attempts: 1 });
    this.emitDiagnosticWarning(
      `codex session ${sessionId}: stale outcome notice append failed; queued for retry`,
    );
    this.scheduleNoticeWriteRetry(sessionId);
  }

  /** 把一条 sidecar 记录 append 进共享路径（持 sidecar 锁）。成功返回 true。 */
  private writeStaleOutcomeEntry(entry: StaleOutcomeEntry): boolean {
    if (!this.sessionStorePath) return true;
    const sidecar = `${this.sessionStorePath}.stale-outcomes`;
    try {
      withFileWriteLock(
        `${sidecar}.lock`,
        () => {
          writeFileSync(sidecar, `${JSON.stringify(entry)}\n`, { flag: 'a' });
        },
        'codex stale-outcomes sidecar',
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 待写通知的定时补写。
   *
   * 到限**不再只留诊断**：落 claim 兜底（独立 finalizer）——写成即持久化
   *（实例注销/进程退出后由孤儿收编送达），兜底成功就停链；此后 append 只在
   * flush/dispose 的机会里做（成功则删兜底副本保持单副本）。
   * **兜底也失败不停链**：仅仅留在内存队列不叫持久化（进程一死就没了），
   * 必须继续低频退避重试（`NOTICE_RETRY_BACKOFF_MS`，unref 不吊住进程），
   * append 与兜底每一轮都再试，直到其一写成；dispose 是最后的 LOST 报告点。
   */
  private static readonly NOTICE_RETRY_FAST_MS = 50;
  private static readonly NOTICE_RETRY_BACKOFF_MS = [50, 100, 250, 500, 1_000, 5_000];
  private scheduleNoticeWriteRetry(sessionId: string): void {
    const pending = this.pendingNoticeWrites.get(sessionId);
    if (!pending || pending.timer) return;
    // 前 5 次快试（50ms，吞掉短暂的锁占用）；到限后转入低频退避（50ms→100ms→250ms→500ms→1s→5s 封顶）
    const delay =
      pending.attempts < 5
        ? CodexAdapter.NOTICE_RETRY_FAST_MS
        : CodexAdapter.NOTICE_RETRY_BACKOFF_MS[
            Math.min(
              pending.attempts - 5,
              CodexAdapter.NOTICE_RETRY_BACKOFF_MS.length - 1,
            )
          ];
    const timer = setTimeout(() => {
      const current = this.pendingNoticeWrites.get(sessionId);
      if (!current) return;
      delete current.timer;
      if (this.writeStaleOutcomeEntry(current.entry)) {
        this.clearNoticeFallback(current);
        this.pendingNoticeWrites.delete(sessionId);
        return;
      }
      current.attempts += 1;
      if (current.attempts >= 5 && this.ensureNoticeFallback(current)) {
        // 兜底已落盘：通知不会再丢。停链，等 flush/dispose 的机会性补写
        return;
      }
      if (current.attempts >= 5) {
        // 兜底也写不进：内存队列不是持久化——继续低频重试，措辞不许暗示已经安全
        this.emitDiagnosticWarning(
          `codex session ${sessionId}: stale outcome notice unwritten after ${current.attempts} attempts (append and claim fallback both failed); still retrying at low frequency (not yet persisted)`,
        );
      }
      this.scheduleNoticeWriteRetry(sessionId);
    }, delay);
    timer.unref?.();
    pending.timer = timer;
  }

  /**
   * 兜底 claim：临时文件写完再 rename 到正式路径（原子出现，不留半截可消费记录）。
   * 唯一文件名不需要锁；实例标识注销（或进程退出）后孤儿收编能带走。
   */
  private fallbackNoticeToClaim(entry: StaleOutcomeEntry): string | undefined {
    if (!this.sessionStorePath) return undefined;
    const claim = `${this.sessionStorePath}.stale-outcomes.${process.pid}.${this.claimOwnerId}.${++this.staleClaimSeq}.claim`;
    const tmp = `${claim}.new`;
    try {
      writeFileSync(tmp, `${JSON.stringify(entry)}\n`, 'utf8');
      renameSync(tmp, claim);
      return claim;
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
      return undefined;
    }
  }

  /** 确保待写通知已有兜底 claim；没有就写一个。 */
  private ensureNoticeFallback(pending: {
    entry: StaleOutcomeEntry;
    fallbackPath?: string | undefined;
  }): boolean {
    if (pending.fallbackPath) return true;
    const claim = this.fallbackNoticeToClaim(pending.entry);
    if (!claim) return false;
    pending.fallbackPath = claim;
    return true;
  }

  /** append 成功后删掉兜底副本（保持单副本；删不掉也只是多一份 noticeId 幂等的重复）。 */
  private clearNoticeFallback(pending: { fallbackPath?: string | undefined }): void {
    if (!pending.fallbackPath) return;
    try {
      rmSync(pending.fallbackPath, { force: true });
    } catch {
      // ignore：noticeId 幂等兜底
    }
    pending.fallbackPath = undefined;
  }

  /**
   * 待写队列的补写机会（loadSession / listSessions / onEvent 都会走到）。
   * 没有定时链在跑的（含已落兜底等机会的）每个机会同步试一次 append。
   */
  private drainPendingNoticeWrites(): void {
    for (const [sessionId, pending] of [...this.pendingNoticeWrites]) {
      if (pending.timer) continue; // 定时补写链在跑的不抢（等它的回合）
      if (this.writeStaleOutcomeEntry(pending.entry)) {
        this.clearNoticeFallback(pending);
        this.pendingNoticeWrites.delete(sessionId);
      }
      // 仍写不进就留队列（兜底 claim 在就不算丢）：dispose 是最后的收尾机会
    }
  }

  /**
   * 领取（claim）sidecar 里的「终态没写进索引」记录。
   *
   * **原子 rename 领取**：`<store>.stale-outcomes` 一次性 rename 成本实例的
   * `<…>.<pid>.<实例UUID>.<seq>.claim` 副本——两个进程同时抢同一个 sidecar 只有一个成功，
   * 读-发-删的旧做法会让同一条提示被发两次；而写入方永远 append 到原路径，
   * 「读取后有人追加、旧读取者把新记录一起删掉」的窗口也随之消失。
   * 文件名里的实例 UUID 保证同进程的多个 Adapter 也不会撞名（rename 会静默覆盖
   * 同名目的地，撞名 = 后领的批次顶掉先领的批次）。
   *
   * **所有 rename 与写入方的 append 共用 sidecar 锁**：append 的 fd 若在 rename
   * 窗口里还开着，追加的字节会落进被领走的 claim 副本、随副本一起删掉——记到最后
   * 的提示不能这样消失。锁被占时这轮不领取（提示留在原地），等下一轮 flush。
   *
   * 持有进程已死的孤儿 claim 文件在这里一并收编（崩溃恢复）——收编同样是原子
   * rename 到本实例名下：两个实例先后看中同一个孤儿时，只有 rename 成功的拿到，
   * 原地认领会让他们各解析一份、同一提示发两次。
   * **领取 ≠ 消费**：记录只在 `flushStaleOutcomeNotices` 确认送达之后才删副本。
   */
  private claimStaleOutcomeFiles(): void {
    if (!this.sessionStorePath) return;
    const file = `${this.sessionStorePath}.stale-outcomes`;
    const base = basename(file);
    const dir = dirname(file);
    /** 本次新领到的副本（只有它们才解析入队，旧副本的提示早已在队列里）。 */
    const fresh: string[] = [];
    try {
      withFileWriteLock(
        `${file}.lock`,
        () => {
          if (existsSync(file)) {
            const claim = `${file}.${process.pid}.${this.claimOwnerId}.${++this.staleClaimSeq}.claim`;
            try {
              renameSync(file, claim);
              this.claimedStaleFiles.push(claim);
              fresh.push(claim);
            } catch {
              // 抢输（别的进程刚领走）：不是我们的
            }
          }
          try {
            for (const name of readdirSync(dir)) {
              if (!name.startsWith(`${base}.`)) continue;
              // `.claim.new` 是兜底 claim 的临时文件（写完 rename 之前崩溃的残留）；
              // 正式副本以 `.claim` 结尾。`.corrupt` 隔离件两者都不匹配，不会被碰
              const isTmp = name.endsWith('.claim.new');
              if (!isTmp && !name.endsWith('.claim')) continue;
              const full = join(dir, name);
              if (this.claimedStaleFiles.includes(full)) continue;
              // `.claim.new` 的段是 [pid, ownerUuid, seq, 'claim', 'new']，
              // `.claim` 的段是 [pid, ownerUuid, seq, 'claim']——liveness 只看前两段
              const segments = name.slice(base.length + 1).split('.');
              const pid = Number(segments[0]);
              const ownerUuid = segments[1];
              if (pid === process.pid) {
                // 本进程的遗留：**进程活着 ≠ 实例活着**。只跳过仍活跃实例（含自己）的
                // claim；dispose 归还失败残留的死实例 claim 必须能被同进程的新实例
                // 收编，否则只认 pid 会把它当「活人不抢」永久滞留
                if (ownerUuid === this.claimOwnerId || (ownerUuid && activeClaimOwners.has(ownerUuid))) continue;
              } else if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
                continue; // 其他还活着的进程：不抢
              }
              // 孤儿收编走 rename：rename 成功才算认领成功，对方再扫时文件已挂上
              // 本实例的名字（活人 pid），不会再收编第二遍
              const adopt = `${file}.${process.pid}.${this.claimOwnerId}.${++this.staleClaimSeq}.claim`;
              if (isTmp) {
                // 崩溃在「临时文件写完、正式 rename 之前」的残留：校验内容后收编
                if (!this.recoverTmpClaim(full, adopt)) continue;
              } else {
                try {
                  renameSync(full, adopt);
                } catch {
                  continue; // 刚被别的实例收编/删除
                }
              }
              this.claimedStaleFiles.push(adopt);
              fresh.push(adopt);
            }
          } catch {
            // 目录读不了不影响主流程
          }
        },
        'codex stale-outcomes sidecar',
      );
    } catch (error) {
      // 锁一直被占：这轮不领取（提示留在原地），下一轮 flush 再来——但不许静默：
      // 崩溃遗留的锁会永久挡住 claim，至少把锁路径与持有者状态留进诊断
      this.emitDiagnosticWarning(
        `codex stale-outcomes claim skipped, lock ${file}.lock unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    for (const claim of fresh) {
      let raw: string;
      try {
        raw = readFileSync(claim, 'utf8');
      } catch {
        continue;
      }
      let anyQueued = false;
      let anyDuplicate = false;
      let anyMalformed = false;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<StaleOutcomeEntry>;
          // 稳定标识：写入时生成、全程保留。旧格式没有 noticeId 的取**确定性** ID
          //（原始行的 SHA-256）——崩溃双副本里两份旧记录内容相同，哈希相同就能
          // 去重；随机 UUID 会让两份各得一个 ID、照样发两次
          const noticeId = parsed.noticeId ?? createHash('sha256').update(trimmed).digest('hex');
          if (this.seenNoticeIds.has(noticeId)) {
            anyDuplicate = true;
            continue;
          }
          this.seenNoticeIds.add(noticeId);
          const message = parsed.message ?? `终态最终未能写入本地索引（上一个实例重试已放弃）`;
          const sessionId = parsed.sessionId ?? '';
          this.pendingStaleNotices.push({
            sessionId: parsed.sessionId,
            message,
            event: createCanonicalEvent({
              streamEpoch: this.normalizer.streamEpoch,
              agentId: 'codex',
              sessionId,
              timestamp: new Date().toISOString(),
              // eventId 从稳定 noticeId 派生：崩溃后重新摄取还是同一个 eventId，
              // 客户端按 eventId 幂等去重——at-least-once 投递不产生重复展示
              eventId: `notice:${sessionId}:PERSIST_FAILED:${noticeId}`,
              sequence: this.normalizer.nextSequence(sessionId),
              type: 'error',
              payload: { code: 'PERSIST_FAILED', message, retryable: false },
            }),
          });
          anyQueued = true;
          this.emitDiagnosticWarning(message);
        } catch {
          // 半行损坏：保留副本（唯一副本不许静默删），与「重复记录」分开处理
          anyMalformed = true;
        }
      }
      if (!anyQueued && !anyDuplicate && anyMalformed) {
        // 全损坏：整份副本解析不出任何有效记录——没有可送内容，「送达后隔离」永远
        // 不会触发（flush 没东西可发会提前返回），留着只会被 dispose 归还共享池、
        // 下个实例再领再解析空转。立即隔离改名保留证据（可能是唯一副本），不等送达。
        try {
          renameSync(claim, `${claim}.corrupt`);
          const index = this.claimedStaleFiles.indexOf(claim);
          if (index >= 0) this.claimedStaleFiles.splice(index, 1);
          this.emitDiagnosticWarning(
            `stale-outcomes claim quarantined immediately (malformed only, nothing to deliver): ${claim}.corrupt`,
          );
        } catch {
          // 改名失败：退回「送达后隔离」路径继续留证据
          this.corruptClaims.add(claim);
          this.emitDiagnosticWarning(
            `stale-outcomes claim kept for quarantine (malformed records): ${claim}`,
          );
        }
        continue;
      }
      if (anyMalformed) {
        this.corruptClaims.add(claim);
        this.emitDiagnosticWarning(
          `stale-outcomes claim kept for quarantine (malformed records): ${claim}`,
        );
      }
      if (!anyQueued && anyDuplicate && !anyMalformed) {
        // 只有「整份副本都是已摄取过的重复记录」才允许直接删；含损坏行的保留到
        // 送达后隔离——损坏的可能是唯一副本，删了就再也找不回来
        const index = this.claimedStaleFiles.indexOf(claim);
        if (index >= 0) this.claimedStaleFiles.splice(index, 1);
        try {
          rmSync(claim, { force: true });
        } catch {
          // 删不掉下次摄取时再试（noticeId 去重不受影响）
        }
      }
    }
  }

  /**
   * 收编崩溃残留的 `.claim.new` 临时文件（`fallbackNoticeToClaim` 写完临时文件、
   * 正式 rename 之前进程没了）。校验通过才算收编成功。
   *
   * **完整合法记录才 rename 成正式 claim**：写入方的产出是「单行 JSON + 换行」，
   * 缺尾换行或任一行解析不动都是崩溃撕裂的半截——不合法的**保留并隔离**
   *（改名 `.corrupt` 留证据），不能静默删除，它可能是这条提示的唯一副本。
   * 收编走 rename：两个实例同时恢复同一个 `.new` 时只有一个成功（对方 ENOENT）。
   */
  private recoverTmpClaim(tmpPath: string, adoptPath: string): boolean {
    let content: string;
    try {
      content = readFileSync(tmpPath, 'utf8');
    } catch {
      return false;
    }
    const lines = content.split('\n');
    const complete = lines[lines.length - 1] === ''; // 写入方必以换行收尾
    const records = complete ? lines.slice(0, -1).filter((line) => line.trim()) : [];
    let legal = complete;
    if (legal) {
      for (const line of records) {
        try {
          JSON.parse(line);
        } catch {
          legal = false;
          break;
        }
      }
    }
    if (legal) {
      try {
        renameSync(tmpPath, adoptPath);
        return true;
      } catch {
        return false; // 刚被别的实例收编/删除
      }
    }
    // 不合法：隔离保留证据（`…claim.new.corrupt`，扫描不会再碰它），绝不静默删
    try {
      renameSync(tmpPath, `${tmpPath}.corrupt`);
      this.emitDiagnosticWarning(
        `stale-outcomes .claim.new quarantined (incomplete or malformed crash leftover, evidence kept): ${tmpPath}.corrupt`,
      );
    } catch {
      // 隔离改名也失败：留在原地下一轮再试，同样不删
    }
    return false;
  }

  /**
   * 把待发的最终失败提示送达事件监听器；没人听就原样留着（不领取、不消费）。
   * 在 `onEvent` 注册后与 `loadSession` / `listSessions` 时调用。
   *
   * **确认送达才删副本**：监听器返回 `false`（注册方是中间层、还没有真正下游）
   * 视为未送达，提示留在队列、claim 副本留在盘上，等下游接上后 `flushPendingNotices`
   * 重发——事件还没送到就不许删记录。
   */
  private flushStaleOutcomeNotices(): void {
    // 待写通知的补写机会：锁已释放的（含到限停表的）在这里再试一次
    this.drainPendingNoticeWrites();
    if (this.listeners.size > 0 && this.sessionStorePath) {
      // 有人听才领取（rename 抢占）：没送达不消费——没人听连领都不领
      this.claimStaleOutcomeFiles();
    }
    if (this.pendingStaleNotices.length === 0 || this.listeners.size === 0) return;
    const notices = this.pendingStaleNotices;
    this.pendingStaleNotices = [];
    const undelivered: typeof notices = [];
    for (const notice of notices) {
      // 重发复用领取时构建的同一事件（同 eventId / sequence）：客户端幂等去重有据可依，
      // 也不给 replay 制造假的序号空洞
      const delivered = notice.sessionId ? this.emitEventWithAck(notice.event) : true;
      if (!delivered) undelivered.push(notice);
    }
    if (undelivered.length > 0) {
      // 没真正送到：退回队列等重试，claim 副本继续留着（不确认消费）
      this.pendingStaleNotices.push(...undelivered);
      return;
    }
    for (const claim of this.claimedStaleFiles.splice(0)) {
      if (this.corruptClaims.delete(claim)) {
        // 含损坏行的副本不静默删：隔离改名保留证据（唯一副本可能就是它）
        try {
          renameSync(claim, `${claim}.corrupt`);
        } catch {
          // ignore
        }
        continue;
      }
      try {
        rmSync(claim, { force: true });
      } catch {
        // 删不掉顶多下次再弹一次，比丢掉强
      }
    }
  }

  /** 下游监听器接上后的重试投递（AgentRegistry 在补发缓存事件后调用）。 */
  flushPendingNotices(): void {
    this.flushStaleOutcomeNotices();
  }

  /**
   * 补交之前落盘失败的执行终态。只在收尾点调用：进程已退出、写锁已释放，
   * 此刻必须把磁盘上的 attempt 收干净（清 runOwner + 终态 runState）。
   *
   * 成功（或 `stale-attempt`：已被新一轮接管）就清掉挂起；仍写不进去则保留挂起，
   * 由调用方暴露持久化失败——绝不假装已经收干净。
   */
  private drainPendingRunOutcome(
    sessionId: string,
  ): 'applied' | 'stale' | 'persist-failed' | 'not-found' | 'none' {
    const pending = this.pendingRunOutcomes.get(sessionId);
    if (!pending) return 'none';
    const record = this.sessions.get(sessionId);
    if (!record) {
      this.pendingRunOutcomes.delete(sessionId);
      return 'none';
    }
    const result = this.persistRunOutcome(sessionId, record, pending.attempt, pending.patch);
    if (result === 'persist-failed') return 'persist-failed';
    this.pendingRunOutcomes.delete(sessionId);
    return result;
  }

  /**
   * 「这一轮根本没开始」的状态写入（例如启动前就被取消）。
   *
   * 走 `setStatus`：不带执行身份，但一轮执行在飞时会被拒绝——那一轮的状态由它自己的
   * attempt 决定，不许被旁路改写。
   */
  private persistStatus(sessionId: string, record: CodexSessionRecord): void {
    record.updatedAt = new Date().toISOString();
    if (!this.sessionStore || !this.isOwnedSession(sessionId)) {
      this.persistOwnedSessions();
      return;
    }
    try {
      this.sessionStore.setStatus(sessionId, {
        status: record.status,
        updatedAt: record.updatedAt,
      });
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex session status persist failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
    this.flushStaleOutcomeNotices();
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
      this.safeCallListener(listener, event);
    }
  }

  /**
   * 单个监听器抛异常必须就地隔离：不能让一个坏监听器毁掉整次派发、更不能让异常
   * 冒充「所有权无法确认」把失败意图重复登记。异常视为未送达（ack 语义）+ 诊断。
   */
  private safeCallListener(
    listener: (event: CanonicalAgentEvent) => unknown,
    event: CanonicalAgentEvent,
  ): boolean {
    try {
      return listener(event) !== false;
    } catch (error) {
      this.emitDiagnosticWarning(
        `event listener threw for ${event.type}/${event.sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
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
    let record!: CodexSessionRecord; // 确定赋值：try 首行即赋值；catch 里另有运行时守卫
    let proc: CodexProcessHandle;
    /**
     * 这一轮的执行标识与身份修订号——都来自 `resolveThreadBinding` 里那次**成功的开跑写入**。
     * 后续换绑 / 收尾以它们为期望值；绝不能事后重新读盘取「最新值」（那可能是别人的）。
     */
    let runStart: CodexRunContext | undefined;
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
        this.persistStatus(sessionId, record);
        this.sessionLocks.delete(sessionId);
        throw new Error('会话任务已取消');
      }

      // 这一轮到底 resume 旧线程还是开新线程，连同「这一轮已经开始」的落盘
      //（runState=starting + attempt），全部由 resolveThreadBinding 一次完成：
      // 那次原子写就是 spawn 的闸门，写不进去就不 spawn。
      const { boundThreadId, lostThreadId, run } = this.resolveThreadBinding(sessionId, record);
      const args: string[] = boundThreadId
        ? ['exec', 'resume', '--json', '--skip-git-repo-check', boundThreadId, message]
        : ['exec', '--json', '--skip-git-repo-check', '-C', record.projectPath, message];
      runStart = run;
      record.updatedAt = new Date().toISOString();

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
      // 这一轮没开起来：内存终态必须落成 failed，不能停在「发送中」——用户会以为消息还在路上。
      // 取消路径已经写好 cancelled，这里不覆盖。落盘尽力而为（锁被占时写不进去就只改内存）。
      if (record && record.status !== 'cancelled') {
        if (runStart) {
          // beginRun 已落盘（有 attempt）：带 fencing 收掉执行（终态 runState + 清 owner）
          this.persistRunOutcome(sessionId, record, runStart.attempt, {
            status: 'failed',
            runState: record.threadId ? 'started' : 'never_started',
          });
        } else {
          // beginRun 都没成功：这一轮没有执行身份，走无 fencing 的状态写入
          record.status = 'failed';
          this.persistStatus(sessionId, record);
        }
      }
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
      // spawn 都没成功 = Codex 那一侧没起过进程：终态 runState 不得留 starting，
      // 否则下次启动会把它当「跑一半被打断」，归属进程还活着时甚至显示成 running。
      const outcome = this.persistRunOutcome(sessionId, record, runStart?.attempt, {
        status: wasCancelled ? 'cancelled' : 'failed',
        runState: record.threadId ? 'started' : 'never_started',
      });
      if (!wasCancelled && outcome !== 'stale') {
        this.emitRunError(
          sessionId,
          `Codex 启动失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }

    if (this.cancelRequested.has(sessionId)) {
      // F3-2：spawn 确认前已被取消——立即终止刚确认的进程。
      // 磁盘终态同样不在这里写：kill ≠ 已退出，终态（清 runOwner）由 onExit（close）统一落盘，
      // 否则 kill/close 窗口里跨实例执行保护被提前放掉（与 cancel 的推迟语义一致）。
      proc.kill();
    } else {
      record.status = 'running';
      record.updatedAt = new Date().toISOString();
    }

    // 送达回执语义（路线图 3.3）：spawn 成功即「已送达电脑」，执行在后台继续；
    // 完成/失败经事件流上报，sendMessage 不等待整个 Agent 执行
    const run = new Promise<void>((resolve, reject) => {
      let buffer = '';
      /** onExit（对应 close）已收尾：此后迟到的 error 不许再改这一轮的终态。 */
      let runClosed = false;
      /** 运行期 error 的失败意图：RUN_FAILED 即时反馈，磁盘终态到 close 才落。 */
      let runError: Error | undefined;
      /**
       * 归属始终无法确认的失败（fail-closed）：终态**照常按 failed 落盘**（finishRun
       * 的 fencing 会拒绝过期写入），但不发任何失败语义事件、waitForRun 不以失败
       * reject——没有栅栏确认就产生确定失败语义，等于把结果发进可能已易主的会话。
       */
      let unverifiedRunError: unknown;

      proc.stdout.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          this.processJsonLine(sessionId, record!, line, runStart);
        }
      });

      proc.onError((error) => {
        // close 之后的迟到 error：这一轮已经收尾（终态已写或已挂起补交），
        // 再写 failed 就是翻案（挂起的取消终态会被覆盖、已收尾的轮次被改判）。
        if (runClosed) {
          return;
        }
        // 用户主动取消后 kill 失败的 error 不得翻案：终态归 cancel 路径所有，
        // 把 cancelled 覆盖成 failed（还发 RUN_FAILED）就是把「用户停止」伪装成「执行失败」。
        //（close 之后的窗口由上面的 runClosed 守卫；不再叠加 record.status 条件——
        // 与这两者互为冗余的条件只会互相掩盖变异，守卫要各自有打得红的观测面。）
        if (this.cancelRequested.has(sessionId)) {
          return;
        }
        // 过期执行的 error 不许冒充当前轮的失败：另一个 Bridge 可能已经 beginRun 接管。
        // 失败意图的「核对 + 登记 + 发事件」在写锁临界区里一次完成（不留 TOCTOU，
        // beginRun 插不进核对与发送之间）；无法确认归属（store 损坏 / 锁被第三方占着）
        // 时**挂起重试确认，不许 fail-open 放行**——最需要 fencing 的时候恰恰是锁被
        // 别人占着的时候。stale / not-found 就地止血：不改内存、不发 RUN_FAILED。
        //
        // 运行期 error ≠ 已退出：RUN_FAILED 立即反馈给用户，但**磁盘终态到 close 才落**——
        // error 时就 finishRun 等于提前清 runOwner、放掉跨实例执行保护。失败意图记在
        // 内存（UI 已经从 RUN_FAILED 知道），close 的收尾据此写 failed 终态（不重发）。
        const applyFailureIntent = () => {
          runError = error;
          record!.status = 'failed';
          record!.updatedAt = new Date().toISOString();
          this.emitRunError(
            sessionId,
            `Codex 运行失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        };
        /** 归属无法确认时的降级登记：只留终态意图，不发事件、不改内存状态。 */
        const deferFailureIntent = () => {
          unverifiedRunError = error;
        };
        const attempt = runStart?.attempt;
        if (!this.sessionStore || !this.isOwnedSession(sessionId) || !attempt) {
          // 没有跨实例竞争对象（无 store / 这一轮没开起来）：直接登记
          this.guardRunFailureRegister(sessionId, applyFailureIntent);
          return;
        }
        const outcome = this.sessionStore.withRunFailureOwnership(sessionId, { attempt }, () =>
          this.guardRunFailureRegister(sessionId, applyFailureIntent),
        );
        if (outcome === 'current') {
          return; // 已在锁内登记并发出
        }
        if (outcome !== 'unavailable') {
          return; // stale-attempt / not-found：就地止血，终态由 close 的 fencing 收尾
        }
        // unavailable：失败意图挂起，定时重试确认；确认前不改状态、不发事件
        this.pendingRunFailures.set(sessionId, {
          attempt,
          error,
          retries: 0,
          apply: applyFailureIntent,
          defer: deferFailureIntent,
        });
        this.scheduleRunFailureConfirm(sessionId);
        // 不 settle：waitForRun 的语义是「这轮执行真正收尾」，由 onExit（close）统一兑现
      });

      proc.onExit((code) => {
        runClosed = true; // 迟到 error 到此为止（见 onError 的 runClosed 守卫）
        // 挂起的失败意图做最后一次归属确认：确认通过/无法确认都到此收尾
        // （无法确认也按失败收尾 + 诊断，磁盘由 finishRun fencing 保护），不带进坟墓
        this.retryPendingRunFailure(sessionId, true);
        if (buffer.trim().length > 0) {
          this.processJsonLine(sessionId, record!, buffer, runStart);
          buffer = '';
        }
        // thread.started 落盘失败过的最后一次重试：下一条 JSON 事件不一定会来，
        // 只靠逐行重试可能永远等不到——Codex 侧已建好的线程不能丢在这里。
        if (runStart && !runStart.threadStartedHandled && runStart.pendingThreadId) {
          const retry = this.commitThreadStarted(sessionId, runStart.pendingThreadId, runStart);
          if (retry.kind === 'committed') {
            this.markThreadCommitted(record!, runStart.pendingThreadId, retry.revision);
            runStart.threadStartedHandled = true;
            runStart.pendingThreadId = undefined;
          } else if (retry.kind === 'failed') {
            // 不许把这一轮伪装成「正常完成且身份已保存」：线程在 Codex 侧存在、索引里
            // 却没绑定——把线程 id 明说出去，用户/诊断还能找回来
            this.emitDiagnosticWarning(
              `codex thread ${runStart.pendingThreadId} binding lost for ${sessionId}: final persist attempt failed`,
            );
            this.emitSessionNotice(
              sessionId,
              'BIND_LOST',
              `Codex 线程 ${runStart.pendingThreadId} 已创建，但绑定落盘失败，下一轮将新建线程继续；原上下文可在 Codex 侧按该 id 找回`,
            );
          }
          // rejected：这一轮已过期，身份归新一轮管——不动也不报警
        }
        this.activeProcesses.delete(sessionId);
        // F5-2：真实进程退出才释放串行锁
        this.sessionLocks.delete(sessionId);
        // 收尾点是补交挂起终态的最后机会（cancel/dispose/运行期 error 落盘失败留下的）：
        // 进程已退出、锁已释放，磁盘上的 attempt 必须在这里收干净（清 runOwner + 终态）。
        this.drainPendingRunOutcome(sessionId);
        // cancelRequested 到此消费掉：close 之前只有 onExit 会消费它，
        // 不再叠加 record.status 条件（与之互为冗余的条件只会互相掩盖变异）
        const wasCancelled = this.cancelRequested.delete(sessionId);
        // 终态 runState 只表达「这轮走到过哪」（threadId 在，含刚重试成功，就是 started）；
        // 终态写入同时清掉 runOwner——进程都退出了还留着它，重启会把已结束的轮次当成还在跑。
        const endedRunState = record!.threadId ? ('started' as const) : ('never_started' as const);
        if (runError || unverifiedRunError !== undefined) {
          // 运行期 error 的失败意图到这一刻才落盘（RUN_FAILED 已在 onError 即时反馈，不重发；
          // 归属无法确认的降级意图只落盘、不发事件）：error ≠ 已退出，提前 finishRun 会
          // 清 runOwner 放掉跨实例执行保护。过期执行由 finishRun 的 attempt fencing 挡成
          // stale，本地状态也不会被动。
          this.persistRunOutcome(sessionId, record!, runStart?.attempt, {
            status: 'failed',
            runState: endedRunState,
          });
        } else if (wasCancelled) {
          // 取消的执行终结在这一刻才落盘（cancel 只表达意图，kill ≠ 已退出）：
          // 提前写终态会把跨实例执行保护放掉，另一个 Bridge 会立刻开出第二轮。
          this.persistRunOutcome(sessionId, record!, runStart?.attempt, {
            status: 'cancelled',
            runState: endedRunState,
          });
        } else if (code === null || code !== 0) {
          // R3-3/F3：非零退出码或信号终止（code=null）按失败处理并上报
          const outcome = this.persistRunOutcome(sessionId, record!, runStart?.attempt, {
            status: 'failed',
            runState: endedRunState,
          });
          // 失败语义的事件只在**栅栏确认通过**（applied）后才发：stale 是过期执行
          // 不冒充当前轮；persist-failed 是归属未经确认（锁被占/写不动），同样不许把
          // 确定失败语义发进可能已易主的会话——终态挂起重试，磁盘由 finishRun fencing 收尾
          if (outcome === 'applied') {
            this.emitRunError(
              sessionId,
              code === null ? 'Codex 进程被信号终止' : `Codex 异常退出（退出码 ${code}）`,
            );
          }
        } else {
          const normStatus = this.normalizer.getSessionStatus(sessionId);
          this.persistRunOutcome(sessionId, record!, runStart?.attempt, {
            status: normStatus ?? (record!.status === 'running' ? 'idle' : record!.status),
            runState: endedRunState,
          });
        }
        this.noticeIfTerminalUnpersisted(sessionId);
        // waitForRun 到这一刻才兑现：运行期 error 以 reject 表达（事件早已反馈过），
        // 其余路径 resolve——error 之后进程可能还活着，提前 settle 就是谎报收尾。
        if (runError) reject(runError);
        else resolve();
      });
    });
    this.runs.set(sessionId, run);
    void run.catch(() => undefined); // 错误已经由 emitRunError 事件上报
  }

  /**
   * 终态最终仍没写进磁盘时如实暴露：其他窗口可能把这个会话显示成运行中、
   * 并把身份操作挡成 in-flight。收尾点已经没有下一次重试机会，必须让人知道。
   */
  private noticeIfTerminalUnpersisted(sessionId: string): void {
    if (!this.pendingRunOutcomes.has(sessionId)) return;
    this.emitSessionNotice(
      sessionId,
      'PERSIST_FAILED',
      '这一轮的结束状态未能写入本地索引，其他窗口可能仍把它显示成运行中；请以 Codex 侧实际状态为准，必要时重启 Nienie 桌面端',
    );
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
    this.emitSessionNoticeWithAck(sessionId, code, message);
  }

  /**
   * 带送达确认的会话提示：监听器显式返回 `false` 表示「没真正送到下游」
   * （中间层自己也还没有下游），调用方必须保留持久副本等重试。
   */
  private emitSessionNoticeWithAck(
    sessionId: string,
    code: string,
    message: string,
  ): boolean {
    return this.emitEventWithAck(
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

  private emitEventWithAck(event: CanonicalAgentEvent): boolean {
    let delivered = false;
    for (const listener of this.listeners) {
      if (this.safeCallListener(listener, event)) {
        delivered = true;
      }
    }
    return delivered;
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
   * 决定这一轮 resume 旧线程还是开新线程，并把「这一轮已经开始」原子写下去。
   *
   * 两件事必须在同一个函数里完成，因为它们的 CAS 基准要来自**同一次成功的决策**：
   * 身份决策（probe + 显式身份操作）给出期望修订号，`beginRun` / `beginNewThreadFromMissing`
   * 用它做 CAS 并返回**本次写入产生的** `attempt` 与 `revision`。之后的换绑就以它们为期望值。
   *
   * 绝不能事后重新读盘拿「最新 revision」当基准：那可能是别的实例刚推进的，
   * 认领它就等于借用了别人的 fencing token——过期执行反过来覆盖了别人的新状态。
   *
   * 决策依据一律是磁盘上的权威绑定（`readBinding` 三态）：
   * - `ok` → **全量**同步进内存（`threadId` / `threadMissing` / `bindingRevision`，包括「磁盘上已经没有」）。
   *   只许 false→true 的单向同步会让本实例拿着别人最新的修订号、却用自己旧的失效事实去决策；
   * - `absent` → 记录还没落盘（全新会话）：以内存为准，修订号按 0；
   * - `unreadable` → **中止这一轮**：拿一份猜出来的身份去换绑就是绕过 CAS，读取失败不得降级成无 CAS。
   *
   * 决策与开跑之间被别人抢先改身份（`mismatch` / `stale-revision` / `in-flight`）→ 重读重判，
   * 最多两轮；两轮都没抢到就**不发这一轮**。新线程就算起来了，它的 `thread.started` 也一定会被
   * CAS 拒绝，结果是 Codex 侧多出一条没有任何记录指向它的线程——正是最初那类幽灵会话。
   */
  private resolveThreadBinding(sessionId: string, record: CodexSessionRecord): {
    boundThreadId: string | undefined;
    lostThreadId: string | undefined;
    run: CodexRunContext;
  } {
    for (let round = 0; round < 2; round += 1) {
      const disk = this.readDiskBinding(sessionId);
      if (disk.status === 'unreadable') {
        this.emitRunError(sessionId, '会话身份读取失败，未启动 Codex 任务，请检查本地存储');
        throw new Error('会话身份读取失败，未启动 Codex 任务，请检查本地存储');
      }
      if (disk.status === 'ok') {
        record.threadId = disk.binding.threadId;
        record.threadMissing = disk.binding.threadMissing === true;
        record.bindingRevision = disk.binding.revision;
        record.bindingEpoch = disk.binding.epoch;
      } else {
        record.bindingRevision = 0;
        record.bindingEpoch = undefined;
      }

      const knownMissing = record.threadMissing === true;
      const bound = record.threadId ?? this.normalizer.getThreadId(sessionId);
      const revision = record.bindingRevision ?? 0;

      /** 这一轮的决策：要不要 resume 哪个线程 + 哪个 id 已确认失效（要连同 starting 一起落盘）。 */
      let decision: {
        boundThreadId: string | undefined;
        lostThreadId: string | undefined;
        markMissingOf: string | undefined;
      };

      if (!bound) {
        decision = { boundThreadId: undefined, lostThreadId: undefined, markMissingOf: undefined };
      } else {
        const probe = this.probeThread(bound);
        if (probe === 'exists') {
          if (knownMissing) {
            // 反向：线程又回来了（用户在 Codex 侧重新同步 / 换回了原来的库）。
            // 之前的设计「不缓存『不存在』」就是为了这一天，所以这里必须真的恢复绑定，
            // 否则标记会一直是 true、每次发消息都重复「换新线程」。
            const restored = this.clearThreadMissing(
              sessionId,
              bound,
              { revision, epoch: record.bindingEpoch },
            );
            if (restored.kind === 'stale') continue; // 别人先改了身份 / 另一轮正在飞：重读磁盘再来
            if (restored.kind === 'ok') {
              record.threadMissing = false;
              record.bindingRevision = restored.revision;
              this.emitDiagnosticWarning(
                `codex thread ${bound} is back; resuming it for ${sessionId}`,
              );
            }
          }
          decision = { boundThreadId: bound, lostThreadId: undefined, markMissingOf: undefined };
        } else if (probe === 'missing') {
          // 一次原子转换：失效标记 + starting + attempt 在同一个临界区里写下去。
          // 分两次写会在中间释放锁：另一个实例可以插进来清掉标记，磁盘就只剩下
          // {threadId: 旧id, runState: starting, 无标记} —— 那正是「恢复成 idle」的配方。
          decision = { boundThreadId: undefined, lostThreadId: bound, markMissingOf: bound };
        } else {
          // unknown：查询失败。已确认失效过 → 持久事实优先，别再拿死 id 去试（但不重复发提示）；
          // 没失效过 → fail-open 照旧 resume，交给 Codex 自己判断。
          if (knownMissing) {
            this.emitDiagnosticWarning(
              `codex thread ${bound} is known-missing but re-check failed; keeping degraded binding for ${sessionId}`,
            );
          }
          decision = {
            boundThreadId: knownMissing ? undefined : bound,
            lostThreadId: undefined,
            markMissingOf: undefined,
          };
        }
      }

      // 开跑闸门：原子写 starting + attempt（写不进去就不 spawn——崩溃窗口的重启判定会失去依据）
      const begun = this.beginRun(
        sessionId,
        { revision: record.bindingRevision ?? revision, epoch: record.bindingEpoch },
        decision.markMissingOf,
      );
      if (begun === 'stale') continue;
      if (begun === 'failed') {
        this.emitRunError(sessionId, '会话状态持久化失败，未启动 Codex 任务，请检查本地存储');
        throw new Error('会话状态持久化失败，未启动 Codex 任务，请检查本地存储');
      }
      // 内存跟进（磁盘已接受）：starting + 本轮的 attempt/revision 一起记下来
      record.runState = 'starting';
      record.runAttempt = begun.attempt;
      record.bindingRevision = begun.revision;
      if (decision.markMissingOf) {
        // 保留 threadId 作「最后已知身份」，只打标记：删掉它会被 store 的「只增不减」合并回来
        record.threadMissing = true;
        this.emitDiagnosticWarning(
          `codex thread ${decision.markMissingOf} no longer exists; starting a new thread for ${sessionId}`,
        );
      }
      return {
        boundThreadId: decision.boundThreadId,
        lostThreadId: decision.lostThreadId,
        run: { attempt: begun.attempt, revision: begun.revision, threadStartedHandled: false },
      };
    }

    // 两轮都被人抢先改身份：说明另一个实例正在主动管理这个会话。
    //
    // 这里**不发**这一轮。新线程就算起来了，它的 `thread.started` 也一定会被 CAS 拒绝
    // （修订号又变了），结果是 Codex 侧多出一个没有任何记录指向它的线程——正是最初那类
    // 「手机端看不见、Codex 里却在」的幽灵会话。而且两个 Bridge 同时给同一个会话开线程
    // 本身就不是「继续」，是分叉。
    this.emitDiagnosticWarning(
      `codex session binding kept changing for ${sessionId}; refusing to start a run`,
    );
    this.emitRunError(sessionId, '会话身份正在被另一个 Nienie 实例修改，本次未启动 Codex 任务');
    throw new Error('会话身份正在被另一个 Nienie 实例修改，本次未启动 Codex 任务');
  }

  /**
   * 开跑闸门：原子写 `runState='starting'` + `runAttempt` + `runOwner`。
   *
   * `markMissingOf` 非空时用 `beginNewThreadFromMissing`（「标记失效 + starting」一次写完）。
   * 返回的 `attempt` / `revision` 是**本次写入产生的**，后续换绑、收尾都以它们为期望值。
   *
   * `stale`：别人在决策与开跑之间改了身份——调用方重读磁盘重判；
   * `failed`：盘上没有这条记录 / 写不进去——调用方中止这一轮。
   */
  private beginRun(
    sessionId: string,
    expected: CodexExpectedBinding,
    markMissingOf: string | undefined,
  ): { attempt: string; revision: number } | 'stale' | 'failed' {
    if (!this.sessionStore || !this.isOwnedSession(sessionId)) {
      // 不归本索引管的会话（Codex 原生线程 / 没配持久化）：纯内存逻辑，没有 CAS 基准
      return { attempt: `memory-${randomUUID()}`, revision: expected.revision };
    }
    try {
      const result: CodexBeginRunResult = markMissingOf
        ? this.sessionStore.beginNewThreadFromMissing(
            sessionId,
            markMissingOf,
            expected,
            new Date().toISOString(),
            this.ownerId,
          )
        : this.sessionStore.beginRun(
            sessionId,
            expected,
            new Date().toISOString(),
            this.ownerId,
          );
      if (result.outcome === 'started') {
        return { attempt: result.attempt, revision: result.revision };
      }
      if (result.outcome === 'not-found') {
        this.emitDiagnosticWarning(
          `codex session ${sessionId} is not in ${this.sessionStorePath}; refusing to start a run`,
        );
        return 'failed';
      }
      return 'stale'; // stale-revision / identity-mismatch：别人的变更比这次决策新
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex session begin-run failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'failed';
    }
  }

  /**
   * `thread.started` 到达后的收尾：**换绑 + `runState='started'` 一次写完**（带 attempt 的 fencing）。
   *
   * - `committed`：磁盘接受了这次收尾，携带新的身份修订号（换绑发生时会 +1）；
   * - `rejected`：这一轮已经过期（attempt 被别的执行接管 / 修订号不是开跑那次的）——
   *   **内存身份不跟着变**，磁盘继续作为权威；
   * - `failed`：写盘失败（锁被占等），可以留到下一行 JSON 再试一次。
   */
  private commitThreadStarted(
    sessionId: string,
    threadId: string,
    runStart: CodexRunContext,
  ): { kind: 'committed'; revision: number } | { kind: 'rejected' } | { kind: 'failed' } {
    if (!this.sessionStore || !this.isOwnedSession(sessionId)) {
      return { kind: 'committed', revision: runStart.revision };
    }
    try {
      const result = this.sessionStore.commitThreadStarted(
        sessionId,
        { attempt: runStart.attempt, revision: runStart.revision },
        threadId,
        new Date().toISOString(),
      );
      if (result.outcome === 'committed') {
        return { kind: 'committed', revision: result.revision };
      }
      this.emitDiagnosticWarning(
        result.outcome === 'stale-attempt'
          ? `codex thread ${threadId} arrived for a stale run of ${sessionId}; disk state wins`
          : `codex thread ${threadId} arrived for a stale run of ${sessionId}; disk binding wins`,
      );
      return { kind: 'rejected' };
    } catch (error) {
      // 落盘失败不阻断这一轮（事件照常上报），但**内存身份不跟着变**：
      // 磁盘写不进去时，内存里改成新 id 就变成「内存是新的、磁盘是旧的」，来回抖动没有终点。
      this.emitDiagnosticWarning(
        `codex session bind failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { kind: 'failed' };
    }
  }

  /** `commitThreadStarted` 落盘成功后把内存身份对齐到磁盘（含 verifiedThreads 缓存）。 */
  private markThreadCommitted(
    record: CodexSessionRecord,
    threadId: string,
    revision: number,
  ): void {
    record.threadId = threadId;
    // 绑定到新线程 = 失效标记解除（旧线程的 id 已经被更可信的新身份取代）
    record.threadMissing = false;
    record.runState = 'started';
    record.bindingRevision = revision;
    // 本进程亲眼看到 thread.started：它就是存在的，不必再查库（见 probeThread）
    this.verifiedThreads.add(threadId);
    // 真实 threadId 一到就落盘：重启后靠它 resume + 回放历史
    this.persistOwnedSessions();
  }

  /**
   * 线程重新出现后恢复绑定：清掉 `threadMissing`，**必须**走 store 的显式操作——
   * `save()` 不允许清除这条否定事实（否则另一个实例的旧快照会把它覆盖掉）。
   *
   * `ok` 携带解除之后的修订号（它是下一次 CAS 的基准）；`stale` 是 `mismatch` / `in-flight`
   * （别人已经换绑、或另一轮执行正在飞），调用方重读磁盘重新判断。
   */
  private clearThreadMissing(
    sessionId: string,
    threadId: string,
    expected: CodexExpectedBinding,
  ): { kind: 'ok'; revision: number } | { kind: 'stale' } | { kind: 'failed' } {
    if (!this.sessionStore || !this.isOwnedSession(sessionId)) {
      return { kind: 'ok', revision: expected.revision };
    }
    try {
      const outcome = this.sessionStore.confirmThreadPresent(sessionId, threadId, expected);
      if (outcome.outcome === 'updated' || outcome.outcome === 'unchanged') {
        return { kind: 'ok', revision: outcome.revision ?? expected.revision };
      }
      if (outcome.outcome === 'mismatch' || outcome.outcome === 'in-flight') {
        return { kind: 'stale' };
      }
      // not-found：记录不在盘上（会被截断/重写）。不假装恢复成功，交给下一轮的 beginRun 判定
      return { kind: 'failed' };
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex session thread restore failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // 清不掉标记不算致命：这一轮仍然 resume（线程确实存在），下一轮会再试
      return { kind: 'failed' };
    }
  }

  /** 读磁盘上的权威绑定；`absent` / `unreadable` 的区分见 `CodexBindingRead`。 */
  private readDiskBinding(sessionId: string): CodexBindingRead {
    if (!this.sessionStore) return { status: 'absent' };
    try {
      return this.sessionStore.readBinding(sessionId);
    } catch {
      return { status: 'unreadable' };
    }
  }

  /** 只有 Nienie 自建会话归本索引管；Codex 原生线程走纯内存逻辑。 */
  private isOwnedSession(sessionId: string): boolean {
    return sessionId.startsWith(NIENIE_SESSION_ID_PREFIX);
  }

  /// 等待某会话当前运行完成（测试与诊断用；sendMessage 本身不等待执行）
  async waitForRun(sessionId: string): Promise<void> {    await this.runs.get(sessionId);
  }

  /**
   * 失败意图登记的异常边界：`register` 回调自身抛异常**不许当成「归属无法确认」**——
   * 后者会挂起重试，把同一失败意图再登记一次、RUN_FAILED 再发一次。逐监听器
   * 隔离（safeCallListener）后监听器异常已经到不了这里，能到这的是登记逻辑自身
   * 的 bug：如实记诊断、就此收尾，绝不重试登记。
   */
  private guardRunFailureRegister(sessionId: string, register: () => void): void {
    try {
      register();
    } catch (error) {
      this.emitDiagnosticWarning(
        `codex session ${sessionId}: run failure register threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 失败意图的挂起重试：store 无法确认归属时先挂着（fail-closed），定时重新确认。
   * 确认通过才登记 + 发 RUN_FAILED；确认已过期（stale / not-found）就地作废。
   */
  private scheduleRunFailureConfirm(sessionId: string): void {
    if (this.runFailureConfirmTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.runFailureConfirmTimers.delete(sessionId);
      this.retryPendingRunFailure(sessionId);
    }, 50);
    timer.unref?.();
    this.runFailureConfirmTimers.set(sessionId, timer);
  }

  private retryPendingRunFailure(sessionId: string, finalTry = false): void {
    const pending = this.pendingRunFailures.get(sessionId);
    if (!pending) return;
    const attempt = pending.attempt;
    if (!this.sessionStore || !this.isOwnedSession(sessionId) || !attempt) {
      this.pendingRunFailures.delete(sessionId);
      this.guardRunFailureRegister(sessionId, pending.apply);
      return;
    }
    let outcome: 'current' | 'stale-attempt' | 'not-found' | 'unavailable';
    outcome = this.sessionStore.withRunFailureOwnership(sessionId, { attempt }, () =>
      this.guardRunFailureRegister(sessionId, pending.apply),
    );
    if (outcome === 'current') {
      this.pendingRunFailures.delete(sessionId);
      return;
    }
    if (outcome !== 'unavailable') {
      // stale-attempt / not-found：失败意图作废（磁盘由 close 的 fencing 收尾）
      this.pendingRunFailures.delete(sessionId);
      return;
    }
    if (finalTry) {
      // close 的最后一次确认仍无法确认归属：**不许 apply**——失败意图没过栅栏就发
      // RUN_FAILED，等于把未经确认的失败语义打进可能已经易主的会话（B 接管后 A 的
      // 事件照样污染 B，finishRun 只护得住磁盘、撤不回事件）。降级为 defer：
      // 终态**照常按 failed 落盘**（finishRun fencing 拒绝过期写入），但不发任何
      // 失败语义事件、waitForRun 不以失败 reject；只如实记诊断 + RUN_OUTCOME_UNKNOWN
      // 会话提示（不置 failed）。
      this.pendingRunFailures.delete(sessionId);
      pending.defer();
      this.emitDiagnosticWarning(
        `codex session ${sessionId}: run failure ownership unconfirmed at close; failure event suppressed (disk terminal still fenced by finishRun)`,
      );
      this.emitSessionNotice(
        sessionId,
        'RUN_OUTCOME_UNKNOWN',
        '执行结果无法确认：运行失败发生在本地索引被其他写入者占用期间，归属核对始终未通过，本次不按失败上报',
      );
      return;
    }
    pending.retries += 1;
    if (pending.retries >= 5) {
      // 重试到限：留到 close 做最后一次确认（不无限重试，也不 fail-open 放行）
      return;
    }
    this.scheduleRunFailureConfirm(sessionId);
  }

  /**
   * 表达「这一轮到此为止」的意图：内存立即呈现「已取消」（UI / cancelRequested），
   * **磁盘终态留给 close 收尾**——kill ≠ 已退出，提前 `finishRun` 会清掉 `runOwner`、
   * 把跨实例执行保护放掉（另一个 Bridge 立刻开出第二轮，两个 Codex 进程抢同一会话）。
   */
  private markCancelIntent(sessionId: string): void {
    this.cancelRequested.add(sessionId);
    const record = this.sessions.get(sessionId);
    if (record && record.status !== 'failed') {
      record.status = 'cancelled';
      record.updatedAt = new Date().toISOString();
      if (!record.runAttempt) {
        // 这一轮根本没开始：没有执行身份要保护，直接落盘 cancelled
        this.persistStatus(sessionId, record);
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    // F5-1：cancel 不释放锁/占位——kill≠已退出，锁由 onExit 真实退出释放，封死双进程窗口
    if (!this.sessionLocks.has(sessionId)) return;
    this.markCancelIntent(sessionId);
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      proc.kill(); // 不删除 activeProcesses——onExit 统一释放
    }
  }

  async dispose(): Promise<void> {
    // 与 cancel 同语义：只表达取消意图，**绝不提前 finishRun**——即使写盘能成功，
    // 那也会在 kill/close 窗口清掉 runOwner、放掉跨实例执行保护。磁盘终态由
    // close 的收尾统一落盘（落盘失败则挂起、定时补交）。
    for (const sessionId of [...this.activeProcesses.keys()]) {
      this.markCancelIntent(sessionId);
    }
    // 补交定时器**不能清**：dispose 可能只是 Adapter 重建，挂起的终态补交
    // （进程退出后把磁盘上的 attempt 收干净）必须跑完——清掉定时器就等于把
    // 「close 时落盘失败」的终态永远留在 starting + runOwner 上。
    this.persistOwnedSessions();
    for (const proc of this.activeProcesses.values()) {
      proc.kill();
    }
    this.activeProcesses.clear();
    // 还没确认送达的 sidecar 领取副本：把内容放回共享池，让下一个 Adapter 能领走
    // （领取 ≠ 消费，dispose 不许把没送到的提示带走）
    if (this.sessionStorePath) {
      for (const claim of this.claimedStaleFiles.splice(0)) {
        let released = false;
        try {
          // 放回共享池的 append 同样持 sidecar 锁（不与任何 claim 的 rename 交错）
          const content = readFileSync(claim, 'utf8');
          withFileWriteLock(
            `${this.sessionStorePath}.stale-outcomes.lock`,
            () => {
              writeFileSync(`${this.sessionStorePath}.stale-outcomes`, content, { flag: 'a' });
            },
            'codex stale-outcomes sidecar',
          );
          released = true;
        } catch {
          // 放不回去（含锁被占）就留着 claim 文件：实例标识在 dispose 末尾注销后，
          // 同进程的新实例也能收编它（进程活着 ≠ 实例活着）
        }
        if (released) {
          try {
            rmSync(claim, { force: true });
          } catch {
            // ignore
          }
        }
      }
    }
    // 通知意图的收尾：最后补写一次；仍写不进共享池就落成本实例名下的 claim 文件
    //（实例标识随即注销，孤儿收编能带走）——不许随 dispose 丢掉最终通知。
    // dispose 之后才产生的晚到通知不靠这里兜底：它们的重试链自己是 finalizer
    //（到限落 claim），不存在「dispose 已结束、无人负责」的窗口
    for (const [sessionId, pending] of [...this.pendingNoticeWrites]) {
      if (pending.timer) clearTimeout(pending.timer);
      if (this.writeStaleOutcomeEntry(pending.entry)) {
        this.clearNoticeFallback(pending);
        this.pendingNoticeWrites.delete(sessionId);
        continue;
      }
      if (this.ensureNoticeFallback(pending)) {
        this.pendingNoticeWrites.delete(sessionId);
        continue;
      }
      // 共享池与 claim 文件都写不进（目录不可写）：只能明确暴露，不假装完成
      this.emitDiagnosticWarning(
        `codex session ${sessionId}: stale outcome notice LOST on dispose (append and claim-file write both failed)`,
      );
      this.pendingNoticeWrites.delete(sessionId);
    }
    // 注销实例标识：本实例名下残留的 claim 从此可被同进程的新实例收编
    activeClaimOwners.delete(this.claimOwnerId);
    this.pendingStaleNotices = [];
    this.listeners.clear();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => unknown): () => void {
    this.listeners.add(listener);
    // 真实 Bridge 先 listSessions 后 onEvent：待发的最终失败提示到这才有人听，
    // 送达之后才确认消费（否则会被发进空监听器集合、静默丢掉）。
    this.flushStaleOutcomeNotices();
    return () => this.listeners.delete(listener);
  }

  private processJsonLine(
    sessionId: string,
    record: CodexSessionRecord,
    line: string,
    runStart: CodexRunContext | undefined,
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
    // `thread.started` 有两种含义：换绑到新线程，或只是确认了本轮 resume 的旧线程。
    // 两条路都必须走同一次收尾写入（换绑 + `runState='started'`）——只在「id 变了」时更新的话，
    // resume 同一个 id 的 `runState` 会永远停在 `starting`，重启后被崩溃判定判成 failed：
    // 一次正常完成的 resume 就这么变成「失败」。
    if (
      threadId &&
      runStart &&
      !runStart.threadStartedHandled &&
      (record.threadId !== threadId || record.runState !== 'started')
    ) {
      // 先落盘、后改内存：磁盘拒绝（过期的执行 / 修订号过期）时不许推进内存身份。
      // 反过来（先改内存再落盘）被拒时会留下「内存是新身份、磁盘是旧身份」的分裂状态。
      runStart.pendingThreadId = threadId; // 落盘失败时留给退出收尾做最后一次重试
      const result = this.commitThreadStarted(sessionId, threadId, runStart);
      if (result.kind !== 'failed') {
        // 写成功只试一次；被拒（这一轮已经过期）也只试一次——重试只会重复写盘
        runStart.threadStartedHandled = true;
      }
      if (result.kind === 'committed') {
        this.markThreadCommitted(record, threadId, result.revision);
        runStart.pendingThreadId = undefined;
      }
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

/** 进程是否还活着（signal 0 探测，只用于 sidecar 孤儿 claim 的收编判断）。 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 首版文件没有 runState：按是否有 threadId 推断。 */
function restoreRunState(session: CodexStoredSession): CodexSessionRunState {
  return session.runState ?? (session.threadId ? 'started' : 'never_started');
}

/**
 * 重启后恢复状态。
 *
 * 两个维度分开看（review：「线程身份已确认」≠「执行是否还活着」）：
 * - `runState` 表达这轮走到过哪：`starting`（spawn 已发出、thread.started 未落盘）、
 *   `started`（身份已确认）、`never_started`（没起来过）；
 * - `runOwner` 表达执行是否还活着：`beginRun` 写入、`finishRun` 终态写入清除。
 *
 * `runOwner` 还在 = 这一轮没写过终态，执行可能仍在进行：
 * - 归属进程活着 → `running`（**不许断言失败**，那会诱导用户再发一次、两条线程分叉）；
 *   `thread.started` 到达不等于执行结束，不能因为 runState 变成 started 就退化成 idle——
 *   用户看到 idle 会重发，另一个 Bridge 的会话锁又互不知情，正好复制出双进程执行；
 * - 归属进程死了 / 跨主机无法验证 → `failed`（这一轮被打断了）；
 * - 已写过终态（`failed` / `cancelled`）→ 照终态显示，不被「归属进程还活着」翻案。
 *
 * 没有 `runOwner` 的 `starting`（旧格式 / 崩溃残留）=「spawn 已发出、thread.started
 * 从未落盘」的中断：恢复成 `failed`，让手机端看到「这一轮被打断了」——再发消息会
 * 新建线程、悄悄丢掉原上下文，必须让用户知情。`cancelled` 例外（启动中被取消是
 * 已了结的一轮）。
 */
function restoreStatus(
  status: AgentStatus,
  runState: CodexSessionRunState,
  runOwner: string | undefined,
): AgentStatus {
  if (runOwner && (runState === 'starting' || runState === 'started')) {
    if (status === 'cancelled') return 'cancelled';
    if (status === 'failed') return 'failed';
    return isRunOwnerAlive(runOwner) ? 'running' : 'failed';
  }
  if (runState === 'starting') {
    return status === 'cancelled' ? 'cancelled' : 'failed';
  }
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
