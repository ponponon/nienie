import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
/**
 * 「内容不可读的锁」多久算孤儿（正常持锁只有几毫秒）。
 * 注意：这只用于**读不出持有者**的锁；能读出 pid 的锁只按进程存活判断，不看年龄。
 */
const LOCK_ORPHAN_MS = 10_000;
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

  /** 把读不动 / 版本不认识的文件改名隔离，避免随后的写盘把它覆盖掉。返回备份路径。 */
  quarantine(reason: 'corrupt' | 'unsupported'): string | undefined {
    if (!existsSync(this.filePath)) return undefined;
    const backupPath = `${this.filePath}.${reason}.${Date.now()}.bak`;
    try {
      renameSync(this.filePath, backupPath);
      return backupPath;
    } catch {
      return undefined;
    }
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
          merged.set(session.id, keepThreadId ? { ...session, threadId: keepThreadId } : session);
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
   */
  private withWriteLock<T>(fn: () => T): T {
    const lockPath = `${this.filePath}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    // 本次调用的唯一标识：既用于临时文件名，也用于「只释放/只回收自己的锁」
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
      if (this.tryAcquireLock(lockPath, token)) {
        try {
          return fn();
        } finally {
          this.releaseLock(lockPath, token);
        }
      }
      if (this.reclaimStaleLock(lockPath, token)) continue;
      const delay = LOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      sleepSync(delay);
    }
    throw new Error(
      `codex session store is locked by another writer (${lockPath}); ` +
        '若确认没有其他 Nienie 实例在运行，删除该锁文件后重试',
    );
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

  /** 释放：只删自己那把（token 对不上说明锁已被别人换掉，动了就会误伤）。 */
  private releaseLock(lockPath: string, token: string): void {
    const holder = tryReadLockHolder(lockPath);
    if (holder && holder.token !== token) return;
    rmSync(lockPath, { force: true });
  }

  /**
   * 回收陈旧锁。返回 true 表示「已处理，可以立刻重试抢锁」。
   *
   * 两条安全规则：
   * 1. **存活进程的锁绝不按年龄抢**——持锁进程可能只是被系统挂起，超过 10 秒不代表它死了；
   * 2. 回收时先 `rename` 成自己独有的名字，只有 rename 成功的一方拿到回收权，且**只删自己
   *    挪走的那个文件**。若挪走后发现内容已经不是刚才判定的那把锁（别人在这瞬间换了新锁），
   *    原样 `link` 放回去，绝不删除——否则两个回收者会互相删掉对方新建的锁，互斥直接失效。
   */
  private reclaimStaleLock(lockPath: string, token: string): boolean {
    const observed = tryReadLockHolder(lockPath);
    if (!isStaleLock(lockPath, observed)) return false;

    const reclaimPath = `${lockPath}.${token}.reclaim`;
    try {
      renameSync(lockPath, reclaimPath);
    } catch (error) {
      // ENOENT：别人已经回收了，直接重试抢锁
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      return false;
    }

    const moved = tryReadLockHolder(reclaimPath);
    const sameLock = sameLockHolder(observed, moved);
    if (!sameLock) {
      // 挪走的是别人刚换上的新锁：放回原位（仅在原位空着时），保住对方的持有权
      try {
        linkSync(reclaimPath, lockPath);
      } catch {
        // EEXIST 等：原位已被占用，放弃放回（那份锁已被新持有者替代，不必恢复）
      } finally {
        rmSync(reclaimPath, { force: true });
      }
      return false;
    }
    rmSync(reclaimPath, { force: true });
    return true;
  }
}

type LockHolder = { pid: number; at: number; token: string };

function tryReadLockHolder(lockPath: string): LockHolder | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockHolder>;
    if (typeof raw.pid !== 'number' || typeof raw.at !== 'number' || typeof raw.token !== 'string') {
      return undefined;
    }
    return { pid: raw.pid, at: raw.at, token: raw.token };
  } catch {
    return undefined;
  }
}

function sameLockHolder(a: LockHolder | undefined, b: LockHolder | undefined): boolean {
  if (!a || !b) return a === b;
  return a.token === b.token && a.pid === b.pid;
}

/**
 * 陈旧判定：
 * - 内容可读 → **只看持有进程是否还活着**，不看年龄；
 * - 内容不可读（旧版本残留 / 非本程序创建）→ 只有文件确实放够了时间才敢回收，
 *   避免抢走「正在被写入」的锁。
 */
function isStaleLock(lockPath: string, holder: LockHolder | undefined): boolean {
  if (holder) return !isProcessAlive(holder.pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_ORPHAN_MS;
  } catch {
    return false;
  }
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
    (candidate.runState === undefined ||
      RUN_STATES.includes(candidate.runState as CodexSessionRunState)) &&
    KNOWN_STATUSES.includes(candidate.status as AgentStatus)
  );
}
