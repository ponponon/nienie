import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { AgentStatus } from '@nienie/protocol';

/** 会话的执行阶段——用来识别「spawn 之后、threadId 落盘之前」的崩溃窗口。 */
export type CodexSessionRunState = 'never_started' | 'starting' | 'started';

/**
 * 持久化的一条 Nienie 自建会话。
 *
 * 为什么只存 Nienie 自己的会话：这类会话在 Codex 侧是 `exec` 来源，桌面端列表看不到，
 * 也不会进 Codex 的交互式线程列表；不自己存一份，Bridge 重启后就彻底丢了。
 * Codex 桌面端原生的会话仍然由 `state_*.sqlite` 负责发现，不在这里复制。
 */
export type CodexStoredSession = {
  id: string;
  /** Codex 真实线程 id；会话创建后、首个 `thread.started` 到达前可能还没有。 */
  threadId?: string | undefined;
  /**
   * 已确认这个 `threadId` 在 Codex 侧不存在（线程被删 / 换机器 / 库被重置）。
   *
   * 与 `threadId` 并存而不是删掉 `threadId`：后者是「最后已知身份」，仍要留给诊断与去重；
   * 而 `threadMissing` 是「不许再拿它 resume」的持久标记。合并时它是粘性的，
   * 只有绑定到新的 threadId 才解除。
   */
  threadMissing?: boolean | undefined;
  title: string;
  projectPath: string;
  status: AgentStatus;
  /** 缺失时按 `threadId ? 'started' : 'never_started'` 推断（兼容首版文件） */
  runState?: CodexSessionRunState | undefined;
  createdAt: string;
  updatedAt: string;
};

/**
 * 读取结果必须区分「没有」和「读不了」：
 * 把「版本不认识 / 文件损坏」当成空数组，紧接着的写盘就会把用户（或新版本）的数据覆盖掉。
 */
export type CodexSessionStoreLoad =
  | { status: 'ok'; sessions: CodexStoredSession[] }
  | { status: 'missing' }
  | { status: 'corrupt' }
  | { status: 'unsupported' };

/** 隔离结果：可能「文件已经被另一个实例修好了」（ok），此时不该再隔离。 */
export type CodexSessionStoreQuarantine =
  | { status: 'ok'; sessions: CodexStoredSession[] }
  | { status: 'missing' }
  | { status: 'quarantined'; reason: 'corrupt' | 'unsupported'; backupPath: string }
  | { status: 'still-broken'; reason: 'corrupt' | 'unsupported' };

type CodexSessionStoreFile = {
  version: 1;
  sessions: CodexStoredSession[];
};

export type CodexSessionStoreOptions = {
  filePath: string;
  /** 最多保留多少条（按 updatedAt 倒序截断），默认 200，避免无限增长。 */
  maxSessions?: number | undefined;
};

const STORE_VERSION = 1;
const DEFAULT_MAX_SESSIONS = 200;
/** 抢锁重试间隔（毫秒）。同步路径上用 Atomics.wait 阻塞，总等待上限约 70ms。 */
const LOCK_RETRY_DELAYS_MS = [10, 20, 40] as const;
const RUN_STATES: readonly CodexSessionRunState[] = ['never_started', 'starting', 'started'];
const KNOWN_STATUSES: readonly AgentStatus[] = [
  'starting',
  'idle',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
];

/**
 * Nienie 自建会话的落盘索引。
 *
 * 写入约定：先读盘合并（按 `id` union，`updatedAt` 新的赢）→ 写同目录临时文件 → `rename` 原子替换。
 * 合并是为了把「另一个 Bridge 实例刚写进去的会话」保留下来，而不是整份覆盖。
 * 读取约定：区分 missing / ok / corrupt / unsupported，后两者由调用方先隔离原文件再决定是否重建。
 */
export class CodexSessionStore {
  private readonly filePath: string;
  private readonly maxSessions: number;

  constructor(options: CodexSessionStoreOptions) {
    this.filePath = options.filePath;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  load(): CodexSessionStoreLoad {
    if (!existsSync(this.filePath)) return { status: 'missing' };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return { status: 'corrupt' };
    }
    if (typeof raw !== 'object' || raw === null) return { status: 'corrupt' };
    const parsed = raw as Partial<CodexSessionStoreFile>;
    if (parsed.version !== STORE_VERSION) return { status: 'unsupported' };
    if (!Array.isArray(parsed.sessions)) return { status: 'corrupt' };
    const sessions = parsed.sessions.filter(isStoredSession);
    // 只要有一条记录结构非法就整份判 corrupt：静默丢弃那条，下一次 save 就永久删掉了它。
    // 宁可让调用方先隔离原文件（内容一字不动），也不要在校验阶段做数据裁剪。
    if (sessions.length !== parsed.sessions.length) return { status: 'corrupt' };
    return { status: 'ok', sessions };
  }

  /**
   * 隔离读不动的文件——**必须在写锁内重读后再决定**，不能拿锁外那次读取的结论动手。
   *
   * 反例（这也是上一版的 bug）：A 在锁外读到 version 99，此时 B 已经把它修好并写入了新会话，
   * A 再 `rename` 就会把 B 刚写好的有效文件挪进备份，B 的会话从当前索引里消失。
   * 所以进入临界区后重新 `load()`：文件已经可用就返回会话让调用方直接用，不再隔离。
   */
  quarantineIfUnusable(): CodexSessionStoreQuarantine {
    return this.withWriteLock(() => {
      const current = this.load();
      if (current.status === 'ok' || current.status === 'missing') return current;
      const backupPath = `${this.filePath}.${current.status}.${Date.now()}.bak`;
      try {
        renameSync(this.filePath, backupPath);
        return { status: 'quarantined', reason: current.status, backupPath };
      } catch {
        return { status: 'still-broken', reason: current.status };
      }
    });
  }

  /**
   * 全量写入：**持写锁**读盘合并（`updatedAt` 较新的赢）→ 截断 → 原子替换。
   *
   * 为什么还要锁：只做「读盘 → 合并 → 写」不足以防并发——两个进程可能读到同一份旧快照，
   * 后写的那个仍会丢掉对方的记录。锁把这段读-改-写变成临界区，配合合并语义，
   * 单文件 + 200 条的规模下足够，不需要换成 SQLite 或事件日志。
   */
  save(sessions: readonly CodexStoredSession[]): void {
    this.withWriteLock(() => {
      const merged = new Map<string, CodexStoredSession>();
      const existing = this.load();
      // fail-closed：读不动的文件绝不当作空集合覆盖。必须由调用方先隔离（quarantine）成
      // missing 才允许重建——否则「隔离失败 → 照写」会整条绕开版本保护。
      if (existing.status === 'corrupt' || existing.status === 'unsupported') {
        throw new Error(
          `codex session store is ${existing.status}; refusing to overwrite ${this.filePath}`,
        );
      }
      if (existing.status === 'ok') {
        for (const session of existing.sessions) merged.set(session.id, session);
      }
      for (const session of sessions) {
        const current = merged.get(session.id);
        if (!current || session.updatedAt >= current.updatedAt) {
          // threadId 只增不减：另一实例的旧快照（还没有 threadId）即使 updatedAt 更新，
          // 也不能把已绑定的 Codex 线程抹掉——这是恢复上下文唯一的依据。
          const keepThreadId = current?.threadId && !session.threadId ? current.threadId : undefined;
          const threadId = keepThreadId ?? session.threadId;
          // 换了新线程 = 重新绑定，失效标记自然解除；否则 threadMissing 是**粘性**的：
          // 它表达「这个 threadId 已被确认不存在」，不能因为另一个实例的旧快照是 undefined
          // 就被抹掉，否则「死 id 仍被当可恢复」会重新出现。
          const rebound = Boolean(session.threadId && session.threadId !== current?.threadId);
          const threadMissing = rebound ? Boolean(session.threadMissing) : current?.threadMissing === true || session.threadMissing === true;
          merged.set(session.id, {
            ...session,
            ...(threadId ? { threadId } : {}),
            ...(threadMissing ? { threadMissing: true } : {}),
          });
        }
      }

      const payload: CodexSessionStoreFile = {
        version: STORE_VERSION,
        sessions: [...merged.values()]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, this.maxSessions),
      };
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      try {
        // 0600：会话标题与项目路径属于本地隐私信息，不给同机其他用户读
        writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        renameSync(tmpPath, this.filePath);
      } finally {
        rmSync(tmpPath, { force: true });
      }
    });
  }

  /**
   * 临界区：`<file>.lock` 的排他创建即持锁。
   *
    * 锁只覆盖一次写入（毫秒级），不做进程生命周期独占——一次崩溃不该把用户永久锁在门外，
   * CLI 与 GUI 共用同一个 Bridge 时也不该互相拒绝启动。抢不到锁退避重试，仍失败就抛错
   * （由调用方写诊断），绝不「无锁照样覆盖」。
   *
   * **不做自动回收**：上一版尝试「判陈旧 → rename 认领 → 核对 → 删」，被 review 指出仍有
   * ABA——延迟的回收者可能把别人刚换上的新锁 rename 走，恢复失败后再删掉，于是两个进程
   * 同时进入临界区。这类状态机要正确必须依赖 compare-and-swap，而文件系统没有。
   * 因此这里退回保守策略：锁存在且抢不到就拒绝写入，并把持有者信息写进错误里，由人确认后
   * 删除锁文件。代价是崩溃在临界区内会暂时挡住持久化，收益是互斥永远不会静默失效。
   */
  private withWriteLock<T>(fn: () => T): T {
    const lockPath = `${this.filePath}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    // 本次调用的唯一标识：既用于临时文件名，也用于「只释放自己的锁」
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
      if (this.tryAcquireLock(lockPath, token)) {
        try {
          return fn();
        } finally {
          this.releaseLock(lockPath, token);
        }
      }
      const delay = LOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      sleepSync(delay);
    }
    throw new Error(`codex session store 被其他写入者占用：${describeLock(lockPath)}`);
  }

  /**
   * 抢锁：先把完整内容写进临时文件，再 `link` 到锁路径。
   *
   * `link` 是原子的，且失败（`EEXIST`）时不留痕迹；更重要的是锁文件一经出现内容就是完整的，
   * 不会出现「刚 open 就被 kill -9」留下的空锁——空锁没法判断持有者，是锁回收的最大麻烦。
   */
  private tryAcquireLock(lockPath: string, token: string): boolean {
    const tmpPath = `${lockPath}.${token}.new`;
    try {
      writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, at: Date.now(), token }), {
        encoding: 'utf8',
        mode: 0o600,
      });
      linkSync(tmpPath, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      // 内容随 inode 一起留在了 lockPath（硬链接），临时名可以立刻删掉
      rmSync(tmpPath, { force: true });
    }
  }

  /**
   * 释放：**只删能确认是自己的那把**。
   *
   * 内容是空的/读不出来时说明这不是我们写的（我们的锁是先写完整内容再 `link`，
   * 不存在半成品），这种情况下删掉就可能删到别人的锁，所以宁可留一个残留锁
   * 让它走「人工确认后删除」的路径。
   */
  private releaseLock(lockPath: string, token: string): void {
    const holder = tryReadLockHolder(lockPath);
    if (!holder || holder.token !== token) return;
    rmSync(lockPath, { force: true });
  }
}

type LockHolder = { pid: number; at: number; token: string };

/**
 * 解析锁内容。任何一项不合法都当作「读不出来」——`describeLock()` 会把它拼进错误信息，
 * 所以这里的校验直接决定了错误信息本身会不会抛异常（`new Date(Infinity).toISOString()`
 * 会抛 RangeError，把真正的「锁被占用」信息覆盖掉）。
 */
function tryReadLockHolder(lockPath: string): LockHolder | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockHolder>;
    if (!Number.isSafeInteger(raw.pid) || (raw.pid ?? 0) <= 0) return undefined;
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined;
    if (!Number.isFinite(new Date(raw.at).getTime())) return undefined;
    if (typeof raw.token !== 'string' || raw.token.length === 0) return undefined;
    return { pid: raw.pid as number, at: raw.at, token: raw.token };
  } catch {
    return undefined;
  }
}

/**
 * 把锁现场描述成人能照着做的信息：路径、持有者 PID、写入时间、以及「这个 PID 还在不在」。
 * 只描述不处理——自动删除活锁/僵尸锁都无法在不具备 CAS 的前提下做对。
 */
function describeLock(lockPath: string): string {
  const holder = tryReadLockHolder(lockPath);
  if (!holder) {
    return `${lockPath}（锁内容不可读，可能是崩溃残留；确认没有其他 Nienie 实例在运行后删除该文件即可）`;
  }
  const alive = isProcessAlive(holder.pid);
  const at = new Date(holder.at).toISOString();
  return alive
    ? `${lockPath}（持有进程 PID ${holder.pid} 仍在运行，写入时间 ${at}；等它写完或退出后重试）`
    : `${lockPath}（持有进程 PID ${holder.pid} 已不存在，是崩溃残留，写入时间 ${at}；删除该文件后重试）`;
}

/** 同步 wait：save() 在同步路径上，不能靠 await 退避。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = 进程不存在；EPERM = 存在但无权限（仍算活着）
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isStoredSession(value: unknown): value is CodexStoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CodexStoredSession>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.title === 'string' &&
    typeof candidate.projectPath === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    (candidate.threadId === undefined || typeof candidate.threadId === 'string') &&
    (candidate.threadMissing === undefined || typeof candidate.threadMissing === 'boolean') &&
    (candidate.runState === undefined ||
      RUN_STATES.includes(candidate.runState as CodexSessionRunState)) &&
    KNOWN_STATUSES.includes(candidate.status as AgentStatus)
  );
}
