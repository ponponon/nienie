import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
   * 全量写入：先与磁盘上的现有内容按 `id` 合并（`updatedAt` 较新的赢），再原子替换。
   * 单进程、200 条上限的规模下，没必要引入 append-only 或跨进程文件锁。
   */
  save(sessions: readonly CodexStoredSession[]): void {
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
