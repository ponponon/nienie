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
   * 而 `threadMissing` 是「不许再拿它 resume」的持久标记。
   *
   * 它的每一次变化都必须走**显式操作**，`save()` 从不改写它：
   * 置位 `markThreadMissing()`、换绑 `bindThreadId()`、恢复 `confirmThreadPresent()`。
   * 原因见 `save()` 的合并规则注释（旧快照既能把身份换回去，也能把失效标记贴到新线程上）。
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

/**
 * 显式身份操作的结果。
 *
 * 为什么不能压成布尔：`false` 同时表示「记录不在盘上」和「本来就不用改」，
 * 调用方没法区分「没找到」和「已经是对的」——前者要建记录，后者可以放心继续。
 */
export type CodexBindingOutcome = 'updated' | 'unchanged' | 'mismatch' | 'not-found';

/** 磁盘上的权威绑定（只含身份字段）。 */
export type CodexStoredBinding = {
  threadId?: string | undefined;
  threadMissing?: boolean | undefined;
};

/**
 * 「线程已确认失效 → 开新线程且已落盘 starting」这次状态转换的结果。
 *
 * 为什么必须是**一次**原子操作而不是「先标记、再写 starting」两次写：两次写之间锁已释放，
 * 另一个实例可以插进来（例如它探测到线程又存在了、调用 confirmThreadPresent 清掉标记），
 * 于是最终磁盘是 `{threadId: th_old, runState: starting, 没有标记}` —— 崩溃后重启，
 * `restoreStatus` 的两个条件都不成立，会话被错误恢复成 `idle`，恰好把崩溃窗口的保证破掉。
 */
export type CodexBeginThreadOutcome =
  | 'started'
  | 'already-marked'
  | 'not-found'
  | 'identity-mismatch';

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
   *
   * 注意 `save()` **不更改线程身份**（见下面的合并规则）：换绑与解除失效标记必须调用
   * `bindThreadId` / `confirmThreadPresent`。
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
          // 身份（threadId / threadMissing）**只由显式操作改写**：save() 不做任何推断。
          //
          // 反例一（identity 回退）：A、B 两个 Bridge 持有同一会话的旧快照。A 检测到旧线程失效
          // → 换到 th_new；B 手里还是 th_old 且 updatedAt 更晚，B 一 save 就把磁盘上的 th_new
          // 改回 th_old。文件锁只保护单次读改写，保护不了「一个实例独占会话生命周期」。
          //
          // 反例二（标记复活）：A 换到 th_new 之后，B 的旧快照是 {th_old, threadMissing: true}。
          // 若这里接受内存里的 true，失效标记就会**附着到新线程**上——新线程明明是活的，
          // 却被永久判死。confirmThreadPresent() 清掉标记后同样会被旧快照写回来。
          //
          // 因此普通 save() 只做一件事：**只补空，只保真**。
          //   threadId：磁盘没有时才接受内存的（只增不减，永不回退）；
          //   threadMissing：磁盘已有就是 true，内存里的真值一概忽略。
          // 换绑 / 置失效 / 解除失效分别走 bindThreadId / markThreadMissing / confirmThreadPresent。
          const threadId = current?.threadId ?? session.threadId;
          const threadMissing = current?.threadMissing === true;
          // 注意：必须先剥掉内存快照里的 threadId / threadMissing 再展开 `...session`。
          // 否则 `...session` 会把内存里的 `threadMissing: true` 原样带回去——「上面算出来不要写」
          // 和「下面又写进去了」同时成立，规则形同虚设（这一版就是这么被自己坑了一次）。
          const { threadId: _memoryThreadId, threadMissing: _memoryThreadMissing, ...rest } = session;
          merged.set(session.id, {
            ...rest,
            ...(threadId ? { threadId } : {}),
            ...(threadMissing ? { threadMissing: true } : {}),
          });
        }
      }
      this.writeSessions([...merged.values()]);
    });
  }

  /**
   * 显式换绑：把会话绑定到 Codex **真实返回**的 `threadId`（`thread.started`），并解除失效标记。
   *
   * 为什么必须是一个专门的操作而不是让 `save()` 看 `threadId` 变了就换绑：另一个实例的旧快照
   * 里的 `threadId` 也是「不同的」，但那是旧身份。只有本进程亲耳听到 `thread.started` 才算事实。
   * 在写锁内读-改-写，因此天然是「以磁盘当前状态为准」的换绑，不会被自己的旧快照回退。
   *
   * `expected` 是 CAS：给出这一轮开始时认识的身份（`oldThreadId: undefined` 表示「当时还没有身份」），
   * 磁盘已经不是那个身份时就返回 `mismatch` 不写——否则一次**过期的执行**里延迟到达的
   * `thread.started` 会把另一个实例刚绑好的新身份覆盖掉。
   */
  bindThreadId(
    sessionId: string,
    threadId: string,
    expected?: { oldThreadId: string | undefined },
  ): CodexBindingOutcome {
    return this.updateBinding(sessionId, (record) => {
      if (expected && record.threadId !== expected.oldThreadId) return 'mismatch';
      if (record.threadId === threadId && record.threadMissing !== true) return 'unchanged';
      record.threadId = threadId;
      delete record.threadMissing;
      return 'updated';
    });
  }

  /**
   * 显式标记「这个线程已被确认不存在」。
   *
   * 为什么不能靠 `save()` 把内存里的 `threadMissing=true` 写下去：另一个实例的旧快照里也可能
   * 带着 `threadMissing=true`（那是**旧线程**的失效事实），一旦被合并到新绑定上，活着的线程
   * 就被永久判死。所以置位同样需要一个指名道姓的操作。
   *
   * 只对「磁盘身份就是这个 id」生效：别的实例已经换绑到新线程时，这条失效事实已经过时，
   * 返回 `mismatch` 不写入。
   *
   * 调用顺序有讲究：必须在 `runState='starting'` 那次关键持久化**之前**完成，
   * 否则「spawn 后、thread.started 前崩溃」的重启判定会重新失去依据
   * （`restoreStatus` 需要 `threadMissing` 才能认出「新线程的身份已经丢了」）。
   */
  markThreadMissing(sessionId: string, threadId: string): CodexBindingOutcome {
    return this.updateBinding(sessionId, (record) => {
      if (record.threadId !== threadId) return 'mismatch';
      if (record.threadMissing === true) return 'unchanged';
      record.threadMissing = true;
      return 'updated';
    });
  }

  /**
   * 一次原子转换：「这个线程已确认不存在，接下来要开新线程，并且这一轮已经进入 starting」。
   *
   * 必须在**同一把写锁**里同时写 `threadMissing = true`、`runState = 'starting'` 和 `updatedAt`：
   * 分两次写会在中间释放锁，另一个实例可以插进来把标记清掉（例如它刚探测到线程恢复），
   * 于是磁盘上留下 `{threadId: 旧id, runState: 'starting', 无标记}` —— 崩溃后重启会被恢复成
   * `idle` 而不是 `failed`，崩溃窗口的保证就没了。
   *
   * `expectedThreadId` 是调用方这一轮开始时认识的身份：磁盘上已经变成别的 id 时说明
   * 另一个实例抢先换绑了，返回 `identity-mismatch` 让调用方重新读盘再判断，
   * 绝不基于过期身份去开新线程。
   */
  beginNewThreadFromMissing(
    sessionId: string,
    expectedThreadId: string,
    updatedAt: string,
  ): CodexBeginThreadOutcome {
    return this.withWriteLock(() => {
      const existing = this.load();
      if (existing.status === 'corrupt' || existing.status === 'unsupported') {
        throw new Error(
          `codex session store is ${existing.status}; refusing to write ${this.filePath}`,
        );
      }
      const sessions = existing.status === 'ok' ? existing.sessions : [];
      const record = sessions.find((session) => session.id === sessionId);
      if (!record) return 'not-found';
      if (record.threadId !== expectedThreadId) return 'identity-mismatch';
      const alreadyMarked = record.threadMissing === true;
      record.threadMissing = true;
      record.runState = 'starting';
      record.updatedAt = updatedAt;
      this.writeSessions(sessions);
      return alreadyMarked ? 'already-marked' : 'started';
    });
  }

  /**
   * 显式确认「同一个线程又存在了」（用户在 Codex 侧重新同步 / 换回了原来的库）。
   *
   * 与 `bindThreadId` 的区别：这里**不换身份**，只有磁盘上的 `threadId` 与被确认的 id 相同才解除
   * 失效标记。这样「另一个实例拿着别的 id 说它存在」不会把失效事实抹掉。
   */
  confirmThreadPresent(sessionId: string, threadId: string): CodexBindingOutcome {
    return this.updateBinding(sessionId, (record) => {
      if (record.threadId !== threadId) return 'mismatch';
      if (record.threadMissing !== true) return 'unchanged';
      delete record.threadMissing;
      return 'updated';
    });
  }

  /**
   * 读磁盘上的权威绑定（多实例场景下「要不要 resume」的决策依据）。
   *
   * 内存快照可能比磁盘旧：另一个 Bridge 已经把线程标成失效（或反过来确认恢复），
   * 本进程却还拿着加载时的旧值。只凭内存判断会出现「别人已经判死，这里还在 resume」。
   * 读不动文件时返回 undefined，调用方退回内存快照（fail-open）。
   */
  readBinding(sessionId: string): CodexStoredBinding | undefined {
    let loaded: CodexSessionStoreLoad;
    try {
      loaded = this.load();
    } catch {
      return undefined;
    }
    if (loaded.status !== 'ok') return undefined;
    const record = loaded.sessions.find((session) => session.id === sessionId);
    if (!record) return undefined;
    return {
      ...(record.threadId ? { threadId: record.threadId } : {}),
      ...(record.threadMissing ? { threadMissing: true } : {}),
    };
  }

  /** 在写锁内对单条记录做一次读-改-写；`mutate` 返回 `unchanged` 时不落盘。 */
  private updateBinding(
    sessionId: string,
    mutate: (record: CodexStoredSession) => CodexBindingOutcome,
  ): CodexBindingOutcome {
    return this.withWriteLock(() => {
      const existing = this.load();
      // 与 save 同样的 fail-closed：读不动的文件不猜内容、不覆盖
      if (existing.status === 'corrupt' || existing.status === 'unsupported') {
        throw new Error(
          `codex session store is ${existing.status}; refusing to write ${this.filePath}`,
        );
      }
      const sessions = existing.status === 'ok' ? existing.sessions : [];
      const record = sessions.find((session) => session.id === sessionId);
      if (!record) return 'not-found';
      const outcome = mutate(record);
      if (outcome === 'updated') this.writeSessions(sessions);
      return outcome;
    });
  }

  /** 原子写：同目录临时文件（0600）→ rename 替换。 */
  private writeSessions(sessions: readonly CodexStoredSession[]): void {
    const payload: CodexSessionStoreFile = {
      version: STORE_VERSION,
      sessions: [...sessions]
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
