import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
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
/** 锁文件超过这个年龄视为崩溃残留（正常持锁只有几毫秒）。 */
const LOCK_STALE_MS = 10_000;
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
    return { status: 'ok', sessions: parsed.sessions.filter(isStoredSession) };
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
      if (existing.status === 'ok') {
        for (const session of existing.sessions) merged.set(session.id, session);
      }
      for (const session of sessions) {
        const current = merged.get(session.id);
        if (!current || session.updatedAt >= current.updatedAt) {
          merged.set(session.id, session);
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
   * 临界区：`<file>.lock` 的 `O_EXCL` 创建即持锁。
   *
   * 锁只覆盖一次写入（毫秒级），不做进程生命周期独占——那样一次崩溃就会把用户永久锁在门外，
   * 而 CLI 与 GUI 共用一个 Bridge 时也不该互相拒绝启动。
   * 抢不到锁有两次重试；仍失败就抛错（由调用方写诊断），绝不「无锁照样覆盖」。
   */
  private withWriteLock<T>(fn: () => T): T {
    const lockPath = `${this.filePath}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    let lastError: unknown;
    for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          closeSync(fd);
        }
        try {
          return fn();
        } finally {
          rmSync(lockPath, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        lastError = error;
        // 持锁进程崩溃会留下锁文件：陈旧就清掉再抢，别让一次崩溃永久禁用持久化
        if (this.clearStaleLock(lockPath)) continue;
        const delay = LOCK_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        sleepSync(delay);
      }
    }
    throw new Error(
      `codex session store is locked by another writer (${lockPath}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /** 锁文件的持有进程已不在、或锁过旧 → 删除。返回是否已清掉。 */
  private clearStaleLock(lockPath: string): boolean {
    let holderPid: number | undefined;
    let lockedAt: number | undefined;
    try {
      const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; at?: number };
      holderPid = typeof raw.pid === 'number' ? raw.pid : undefined;
      lockedAt = typeof raw.at === 'number' ? raw.at : undefined;
    } catch {
      // 内容读不出来（刚创建还没写完）——按「可能有效」处理，交给重试/超时
      return false;
    }
    const expired = lockedAt !== undefined && Date.now() - lockedAt > LOCK_STALE_MS;
    if (expired) {
      rmSync(lockPath, { force: true });
      return true;
    }
    if (holderPid !== undefined && !isProcessAlive(holderPid)) {
      rmSync(lockPath, { force: true });
      return true;
    }
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
