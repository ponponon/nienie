import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
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
 *
 * 字段分两套，**由两组不同的操作分别改写**：
 * - 身份（`threadId` / `threadMissing` / `bindingRevision`）：绑的是「Codex 里哪个线程」，
 *   只由 `bindThreadId` / `markThreadMissing` / `confirmThreadPresent` 改；
 * - 执行（`status` / `runState` / `runAttempt` / `runOwner`）：绑的是「哪一轮跑、谁在跑」，
 *   只由 `beginRun` / `beginNewThreadFromMissing` / `commitThreadStarted` / `finishRun` / `setStatus` 改。
 * 普通 `save()` 两套都不碰（只写标题、项目路径、时间戳），原因见那里的注释。
 */
export type CodexStoredSession = {
  id: string;
  /** Codex 真实线程 id；会话创建后、首个 `thread.started` 到达前可能还没有。 */
  threadId?: string | undefined;
  /**
   * 身份修订号：每次身份或失效状态变化 +1，由身份操作维护。
   *
   * 为什么不用「threadId 变了没有」做 CAS：线程可能 `missing → 恢复 → 又 missing`，
   * 两次比较看到的 id 一模一样，但中间已经被别的实例改过一轮。修订号单调递增，
   * 只比较 id 会漏掉这种「值回到旧样子」的并发，修订号不会。
   */
  bindingRevision?: number | undefined;
  /**
   * 记录的生成代（generation）：新建记录时随机生成，永不改变、不从旧快照导入。
   *
   * 为什么修订号不够：记录被删掉（整份重写/截断）又重建时，修订号会从 0 重新开始，
   * 一份拿着「旧纪元 revision 0」的过期认识会再次通过 CAS，接管不属于它的新记录。
   * 生成代与记录同生共死：重建 = 新代，过期期望值必然对不上。
   */
  epoch?: string | undefined;
  /**
   * 已确认这个 `threadId` 在 Codex 侧不存在（线程被删 / 换机器 / 库被重置）。
   *
   * 与 `threadId` 并存而不是删掉 `threadId`：后者是「最后已知身份」，仍要留给诊断与去重；
   * 而 `threadMissing` 是「不许再拿它 resume」的持久标记。
   */
  threadMissing?: boolean | undefined;
  title: string;
  projectPath: string;
  status: AgentStatus;
  /** 缺失时按 `threadId ? 'started' : 'never_started'` 推断（兼容首版文件） */
  runState?: CodexSessionRunState | undefined;
  /**
   * 执行标识（fencing token）：`beginRun` 原子创建，标识「哪一轮执行」。
   *
   * 为什么需要它：`runState` 描述的是**某一轮**的阶段，但普通保存没有执行身份，
   * 一次迟到的收尾写入会把新一轮的执行阶段覆盖掉。带上 attempt 之后，
   * `finishRun` / `commitThreadStarted` 只在 attempt 还是自己时才写。
   */
  runAttempt?: string | undefined;
  /** 执行归属：`${pid}@${hostname}`。重启后据此判断「这一轮是不是真的没人跑了」。 */
  runOwner?: string | undefined;
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
 * 身份操作的结果。
 *
 * 为什么不能压成布尔：`false` 同时表示「记录不在盘上」和「本来就不用改」，
 * 调用方没法区分「没找到」和「已经是对的」——前者要建记录，后者可以放心继续。
 */
export type CodexBindingResult = {
  outcome: 'updated' | 'unchanged' | 'mismatch' | 'in-flight' | 'not-found';
  /** 本次结果对应的磁盘修订号；`not-found` 时没有。 */
  revision?: number | undefined;
};

/** 磁盘上的权威绑定（只含身份字段）。 */
export type CodexStoredBinding = {
  threadId?: string | undefined;
  threadMissing?: boolean | undefined;
  /** 身份修订号（缺失按 0 处理），CAS 用它比较。 */
  revision: number;
  /** 记录生成代（老记录缺失）。CAS 同时比较它，防 absent→重建 的 ABA。 */
  epoch?: string | undefined;
};

/** 身份/开跑操作的 CAS 期望值：修订号必填，生成代由调用方从权威绑定里带下来。 */
export type CodexExpectedBinding = { revision: number; epoch?: string | undefined };

/**
 * `readBinding()` 的三态结果。
 *
 * 「文件不在」「记录不在」「文件读不动」在并发决策里是三件完全不同的事：
 * 前两者可以从零开始，后者必须中止（拿一份猜出来的身份去换绑就是绕过 CAS）。
 * 之前压成一个 `undefined` 全部当「回退内存快照」，正好在最危险的时刻放行。
 */
export type CodexBindingRead =
  | { status: 'ok'; binding: CodexStoredBinding }
  | { status: 'absent' }
  | { status: 'unreadable' };

/**
 * 「开始一轮执行」的结果。
 *
 * `started` 携带**本次原子写入产生的** `attempt` 与 `revision`：后续换绑 / 收尾都以它们为
 * 期望值。不能事后重新读盘拿「最新 revision」——那可能是别的实例刚推进的，认领它就等于
 * 借用了别人的 fencing token。
 */
export type CodexBeginRunResult =
  | { outcome: 'started'; attempt: string; revision: number }
  | { outcome: 'stale-revision'; revision: number }
  | { outcome: 'identity-mismatch'; revision: number }
  | { outcome: 'not-found' };

/** `thread.started` 到达后的收尾：换绑 + `runState='started'` 一次写完。 */
export type CodexCommitRunResult =
  | { outcome: 'committed'; revision: number }
  | { outcome: 'stale-attempt' }
  | { outcome: 'stale-revision'; revision: number }
  | { outcome: 'not-found' };

export type CodexFinishRunResult = 'finished' | 'stale-attempt' | 'not-found';
export type CodexSetStatusResult = 'updated' | 'in-flight' | 'not-found';

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
 * 写入约定：先读盘合并（按 `id` union）→ 写同目录临时文件 → `rename` 原子替换。
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
   * 全量写入：**持写锁**读盘合并 → 截断 → 原子替换。
   *
   * 为什么还要锁：只做「读盘 → 合并 → 写」不足以防并发——两个进程可能读到同一份旧快照，
   * 后写的那个仍会丢掉对方的记录。锁把这段读-改-写变成临界区，配合合并语义，
   * 单文件 + 200 条的规模下足够，不需要换成 SQLite 或事件日志。
   *
   * **`save()` 只写展示字段**（标题、项目路径、时间戳），既不写身份也不写执行状态：
   *
   * - 身份（`threadId` / `threadMissing` / `bindingRevision`）由显式身份操作改写。
   *   反例（identity 回退）：A、B 两个 Bridge 持有同一会话的旧快照。A 检测到旧线程失效
   *   → 换到 th_new；B 手里还是 th_old 且 updatedAt 更晚，B 一 save 就把磁盘上的 th_new
   *   改回 th_old。文件锁只保护单次读改写，保护不了「一个实例独占会话生命周期」。
   *   反例二（绕过 CAS）：磁盘没有 `threadId` 时由 `save()` 补上内存里的，身份变了而
   *   修订号没变，一个拿着旧修订号的过期执行照样能通过 CAS——所以连「补空」也不许做。
   * - 执行状态（`status` / `runState` / `runAttempt` / `runOwner`）由带 fencing 的执行操作改写。
   *   反例：Bridge B 重启后按「starting → 被打断」把状态在内存里恢复成 failed（展示用），
   *   紧接着的 `save()` 若把这个派生值写回共享索引，就等于把「恢复时认为失败」变成
   *   「事实上的失败」——而另一个 Bridge 的进程可能还活着。
   *
   * 例外是**新建记录**（磁盘上没有这条 id）：此时内存就是唯一来源，标题、状态照常写入，
   * 但 `bindingRevision` 恒为 0、`runAttempt` / `runOwner` 不导入——那是一个「新索引条目」，
   * 不是任何一轮执行的延续，把旧快照的修订号/执行标识带进来就是伪造历史。
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
        if (!current) {
          merged.set(session.id, {
            id: session.id,
            title: session.title,
            projectPath: session.projectPath,
            status: session.status,
            runState: session.runState ?? 'never_started',
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            // 身份只在新建时带上（此时没有既有状态可绕过），但修订号从 0 起：
            // 旧快照携带的修订号属于另一个文件纪元，导入它会让 CAS 的基准失去意义。
            ...(session.threadId ? { threadId: session.threadId } : {}),
            ...(session.threadMissing ? { threadMissing: true } : {}),
            // 新记录 = 新的生成代：识别「记录被删后重建」，挡掉旧纪元的过期期望值
            epoch: randomUUID(),
          });
          continue;
        }
        if (session.updatedAt >= current.updatedAt) {
          merged.set(session.id, {
            ...current,
            title: session.title,
            projectPath: session.projectPath,
            updatedAt: session.updatedAt,
          });
        }
      }
      this.writeSessions([...merged.values()]);
    });
  }

  /**
   * 显式换绑：把会话绑定到 Codex **真实返回**的 `threadId`（`thread.started`），并解除失效标记。
   *
   * `expected.revision` 是 CAS，**必填**：用修订号而不是 id 比较——id 可能
   * `missing → 恢复 → 又 missing` 回到旧样子，只比 id 会漏掉这种并发。
   * 不给期望值就等于「无条件写入」，存储异常时 CAS 会被静默关掉，所以不留这个口子。
   *
   * 一轮执行在飞（`runState='starting'` 且归属进程还活着）时拒绝：那一轮正准备用它的
   * 修订号交 `thread.started`，此时推进修订号会让它的新线程变成无人认领的幽灵线程。
   */
  bindThreadId(
    sessionId: string,
    threadId: string,
    expected: CodexExpectedBinding,
  ): CodexBindingResult {
    return this.mutateBinding(sessionId, expected, (record) => {
      if (record.threadId === threadId && record.threadMissing !== true) return 'unchanged';
      record.threadId = threadId;
      delete record.threadMissing;
      record.bindingRevision = revisionOf(record) + 1;
      return 'updated';
    });
  }

  /**
   * 显式标记「这个线程已被确认不存在」。
   *
   * 只对「磁盘身份就是这个 id」生效：别的实例已经换绑到新线程时，这条失效事实已经过时，
   * 返回 `mismatch` 不写入。执行在飞时同样拒绝（理由同 `bindThreadId`）。
   */
  markThreadMissing(
    sessionId: string,
    threadId: string,
    expected: CodexExpectedBinding,
  ): CodexBindingResult {
    return this.mutateBinding(sessionId, expected, (record) => {
      if (record.threadId !== threadId) return 'mismatch';
      if (record.threadMissing === true) return 'unchanged';
      record.threadMissing = true;
      record.bindingRevision = revisionOf(record) + 1;
      return 'updated';
    });
  }

  /**
   * 显式确认「同一个线程又存在了」（用户在 Codex 侧重新同步 / 换回了原来的库）。
   *
   * 与 `bindThreadId` 的区别：这里**不换身份**，只有磁盘上的 `threadId` 与被确认的 id 相同才解除
   * 失效标记。这样「另一个实例拿着别的 id 说它存在」不会把失效事实抹掉。
   */
  confirmThreadPresent(
    sessionId: string,
    threadId: string,
    expected: CodexExpectedBinding,
  ): CodexBindingResult {
    return this.mutateBinding(sessionId, expected, (record) => {
      if (record.threadId !== threadId) return 'mismatch';
      if (record.threadMissing !== true) return 'unchanged';
      delete record.threadMissing;
      record.bindingRevision = revisionOf(record) + 1;
      return 'updated';
    });
  }

  /**
   * 开始一轮执行（resume 既有线程 / 全新线程都走这里）：原子写 `runState='starting'` +
   * `runAttempt` + `runOwner`，返回**本次写入产生的** attempt 与身份修订号。
   *
   * 为什么 attempt 必须在这里诞生：`runState='starting'` 是崩溃判定的依据（重启后认成
   * 「跑了一半被打断」），而收尾写入（`finishRun` / `commitThreadStarted`）必须证明
   * 「就是那一轮」才允许改——否则迟到的旧执行会把新一轮的执行阶段覆盖掉。
   *
   * 没有执行租约（路线图）时，新的一轮总是接管旧的 attempt：两个 Bridge 同时跑同一个会话
   * 的互斥不在这层解决，这里只保证「旧执行改不了新执行的状态」。
   */
  beginRun(
    sessionId: string,
    expected: CodexExpectedBinding,
    updatedAt: string,
    owner: string,
  ): CodexBeginRunResult {
    return this.withWriteLock(() => {
      const existing = this.load();
      if (existing.status === 'corrupt' || existing.status === 'unsupported') {
        throw new Error(
          `codex session store is ${existing.status}; refusing to write ${this.filePath}`,
        );
      }
      const sessions = existing.status === 'ok' ? existing.sessions : [];
      const record = sessions.find((session) => session.id === sessionId);
      if (!record) return { outcome: 'not-found' };
      if (revisionOf(record) !== expected.revision) {
        return { outcome: 'stale-revision', revision: revisionOf(record) };
      }
      if (!epochMatches(record, expected)) {
        // 记录被删后重建（新生成代）：修订号会回到 0，只有生成代认得出这不是原来那条
        return { outcome: 'identity-mismatch', revision: revisionOf(record) };
      }
      record.runState = 'starting';
      record.runAttempt = randomUUID();
      record.runOwner = owner;
      record.updatedAt = updatedAt;
      this.writeSessions(sessions);
      return { outcome: 'started', attempt: record.runAttempt, revision: revisionOf(record) };
    });
  }

  /**
   * 一次原子转换：「这个线程已确认不存在，接下来要开新线程，且这一轮已经进入 starting」。
   *
   * 为什么「标记」和「starting」要写在**同一把锁**里：分两次写会在中间释放锁，
   * 另一个实例可以插进来把标记清掉（例如它刚探测到线程恢复），于是磁盘上留下
   * `{threadId: 旧id, runState: starting, 无标记}`。虽然崩溃判定现在只看 `runState`，
   * 但「这一轮是基于失效判断开的新线程」这件事仍然要和它绑在一起写，避免半截状态。
   *
   * 返回的 `revision` 是**本次写入之后**的修订号：后续 `thread.started` 的换绑 CAS 用它。
   * 别的实例在这之后推进的修订号不属于这一轮，认领它就等于借用了别人的 fencing token。
   */
  beginNewThreadFromMissing(
    sessionId: string,
    expectedThreadId: string,
    expected: CodexExpectedBinding,
    updatedAt: string,
    owner: string,
  ): CodexBeginRunResult {
    return this.withWriteLock(() => {
      const existing = this.load();
      if (existing.status === 'corrupt' || existing.status === 'unsupported') {
        throw new Error(
          `codex session store is ${existing.status}; refusing to write ${this.filePath}`,
        );
      }
      const sessions = existing.status === 'ok' ? existing.sessions : [];
      const record = sessions.find((session) => session.id === sessionId);
      if (!record) return { outcome: 'not-found' };
      if (record.threadId !== expectedThreadId) {
        return { outcome: 'identity-mismatch', revision: revisionOf(record) };
      }
      if (revisionOf(record) !== expected.revision) {
        return { outcome: 'stale-revision', revision: revisionOf(record) };
      }
      if (!epochMatches(record, expected)) {
        return { outcome: 'identity-mismatch', revision: revisionOf(record) };
      }
      if (record.threadMissing !== true) {
        record.threadMissing = true;
        record.bindingRevision = revisionOf(record) + 1;
      }
      record.runState = 'starting';
      record.runAttempt = randomUUID();
      record.runOwner = owner;
      record.updatedAt = updatedAt;
      this.writeSessions(sessions);
      return { outcome: 'started', attempt: record.runAttempt, revision: revisionOf(record) };
    });
  }

  /**
   * `thread.started` 到达后的收尾：**换绑 + `runState='started'` 一次写完**。
   *
   * 为什么合成一个操作：
   * - 换绑是身份变更，必须走 CAS（`expected.revision`），否则过期执行能覆盖别人刚绑好的身份；
   * - `runState='started'` 是执行阶段，必须走 fencing（`expected.attempt`）；
   * - 而 resume 同一个 `threadId` 时**根本没有换绑**（`threadId` 相等），若只在
   *   「id 变了」时才更新，`runState` 会永远停在 `starting`，重启后被崩溃判定判成 failed
   *   ——一次正常完成的 resume 就这么变成「失败」。所以两条路径都从这个口走。
   */
  commitThreadStarted(
    sessionId: string,
    expected: { attempt: string; revision: number },
    threadId: string,
    updatedAt: string,
  ): CodexCommitRunResult {
    return this.withWriteLock(() => {
      const existing = this.load();
      if (existing.status === 'corrupt' || existing.status === 'unsupported') {
        throw new Error(
          `codex session store is ${existing.status}; refusing to write ${this.filePath}`,
        );
      }
      const sessions = existing.status === 'ok' ? existing.sessions : [];
      const record = sessions.find((session) => session.id === sessionId);
      if (!record) return { outcome: 'not-found' };
      // fencing：这已经不是发起那一轮了，迟到的收尾不许改状态
      if (record.runAttempt !== expected.attempt) return { outcome: 'stale-attempt' };
      if (revisionOf(record) !== expected.revision) {
        return { outcome: 'stale-revision', revision: revisionOf(record) };
      }
      if (record.threadId !== threadId || record.threadMissing === true) {
        record.threadId = threadId;
        delete record.threadMissing;
        record.bindingRevision = revisionOf(record) + 1;
      }
      record.runState = 'started';
      record.updatedAt = updatedAt;
      this.writeSessions(sessions);
      return { outcome: 'committed', revision: revisionOf(record) };
    });
  }

  /**
   * 一轮执行的收尾（进程退出 / spawn 失败 / 取消）：带 attempt 的 fencing 写入。
   *
   * 迟到的旧执行在这里被挡住（`stale-attempt`），不会把新一轮的 `runState` / `status` 改回去。
   */
  finishRun(
    sessionId: string,
    expected: { attempt: string },
    patch: { status: AgentStatus; runState?: CodexSessionRunState | undefined; updatedAt: string },
  ): CodexFinishRunResult {
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
      if (record.runAttempt !== expected.attempt) return 'stale-attempt';
      record.status = patch.status;
      record.runState = patch.runState ?? 'started';
      // 终态 = 这一轮执行结束：清掉归属标记，「执行是否还活着」从此由 runOwner 表达，
      // 而 runState 只表达「这轮走到过哪」。不清的话重启会把已结束的轮次当成还在跑。
      delete record.runOwner;
      record.updatedAt = patch.updatedAt;
      this.writeSessions(sessions);
      return 'finished';
    });
  }

  /**
   * 不带执行身份的状态写入——**只给「这一轮根本没开始」的场景**用（例如启动前就被取消）。
   *
   * 一轮执行在飞时拒绝：那一轮的状态由它自己的 attempt 决定，不许被旁路改写。
   */
  setStatus(
    sessionId: string,
    patch: { status: AgentStatus; updatedAt: string },
  ): CodexSetStatusResult {
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
      if (attemptInFlight(record)) return 'in-flight';
      record.status = patch.status;
      record.updatedAt = patch.updatedAt;
      this.writeSessions(sessions);
      return 'updated';
    });
  }

  /**
   * 读磁盘上的权威绑定（多实例场景下「要不要 resume」的决策依据）。
   *
   * 内存快照可能比磁盘旧：另一个 Bridge 已经把线程标成失效（或反过来确认恢复），
   * 本进程却还拿着加载时的旧值。只凭内存判断会出现「别人已经判死，这里还在 resume」。
   */
  readBinding(sessionId: string): CodexBindingRead {
    let loaded: CodexSessionStoreLoad;
    try {
      loaded = this.load();
    } catch {
      return { status: 'unreadable' };
    }
    if (loaded.status === 'corrupt' || loaded.status === 'unsupported') {
      return { status: 'unreadable' };
    }
    if (loaded.status === 'missing') return { status: 'absent' };
    const record = loaded.sessions.find((session) => session.id === sessionId);
    if (!record) return { status: 'absent' };
    return {
      status: 'ok',
      binding: {
        ...(record.threadId ? { threadId: record.threadId } : {}),
        ...(record.threadMissing ? { threadMissing: true } : {}),
        revision: revisionOf(record),
        ...(record.epoch ? { epoch: record.epoch } : {}),
      },
    };
  }

  /**
   * 身份操作的公共骨架：CAS 校验 + 在飞保护 + 读-改-写。
   *
   * `expected.revision` 必填（见 `bindThreadId`）。执行在飞时不动任何字段并返回 `in-flight`：
   * 那一轮正准备用它的修订号交 `thread.started`，此刻推进修订号会让它的新线程
   * 变成无人认领的幽灵线程。
   */
  private mutateBinding(
    sessionId: string,
    expected: CodexExpectedBinding,
    mutate: (record: CodexStoredSession) => 'updated' | 'unchanged' | 'mismatch',
  ): CodexBindingResult {
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
      if (!record) return { outcome: 'not-found' };
      if (attemptInFlight(record)) {
        return { outcome: 'in-flight', revision: revisionOf(record) };
      }
      if (revisionOf(record) !== expected.revision) {
        return { outcome: 'mismatch', revision: revisionOf(record) };
      }
      if (!epochMatches(record, expected)) {
        return { outcome: 'mismatch', revision: revisionOf(record) };
      }
      const outcome = mutate(record);
      if (outcome === 'updated') this.writeSessions(sessions);
      return { outcome, revision: revisionOf(record) };
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

/** 缺失按 0 处理：首版文件没有这个字段。 */
function revisionOf(record: CodexStoredSession): number {
  return record.bindingRevision ?? 0;
}

/**
 * 生成代校验：期望值与记录必须同代。
 *
 * 严格相等（含「都没有」）：调用方拿着旧纪元（或「当时记录不在」）的期望值，
 * 对上一条被删后重建的新记录（新生成代）必须拒绝——重建后修订号从 0 重新开始，
 * 只比修订号会把过期认识放行。
 */
function epochMatches(record: CodexStoredSession, expected: CodexExpectedBinding): boolean {
  return (record.epoch ?? undefined) === (expected.epoch ?? undefined);
}

/**
 * 「这一轮执行是不是还在飞」= 有 attempt 有归属、归属进程还活着，且还没写过终态。
 *
 * `runState` 表达「这轮走到过哪」（starting = 已提交启动还没 thread.started；
 * started = 身份已确认），`runOwner` 表达「执行是否还活着」——`finishRun` 终态写入
 * 会清掉它。所以判活看 owner，不看 runState 走到了哪一步：`thread.started` 到达
 * 不等于执行结束，把「还在跑」的轮次当成 idle 会诱导用户再发一次、两条线程分叉。
 *
 * 归属进程已死（或归属信息不可验证）就不算在飞：那时旧执行的 attempt 是死的，
 * 身份操作必须放行，否则线程回来后连 `confirmThreadPresent` 都做不了。
 * 终态（failed / cancelled）同样不算在飞：已经了结的轮次不许永久挡住身份操作。
 */
function attemptInFlight(record: CodexStoredSession): boolean {
  if (record.status === 'failed' || record.status === 'cancelled') return false;
  if (record.runState !== 'starting' && record.runState !== 'started') return false;
  return !!record.runAttempt && !!record.runOwner && isRunOwnerAlive(record.runOwner);
}

/**
 * 归属进程是否还活着。
 *
 * 重启后的崩溃判定用它区分「这一轮真的没人跑了」（→ failed）和「另一个 Bridge 还在跑」
 * （→ 不许断言失败，更不许把派生状态写回共享索引）。这是租约缺席时的替代判据。
 */
export function isRunOwnerAlive(runOwner: string | undefined): boolean {
  if (!runOwner) return false;
  const at = runOwner.lastIndexOf('@');
  if (at <= 0) return false;
  const pid = Number(runOwner.slice(0, at));
  const host = runOwner.slice(at + 1);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  // 跨主机的共享索引无法验证进程存活：保守当作「没人跑了」，避免永久挡住身份操作
  if (host !== hostname()) return false;
  return isProcessAlive(pid);
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
    (candidate.bindingRevision === undefined ||
      (typeof candidate.bindingRevision === 'number' &&
        Number.isSafeInteger(candidate.bindingRevision) &&
        candidate.bindingRevision >= 0)) &&
    (candidate.runState === undefined ||
      RUN_STATES.includes(candidate.runState as CodexSessionRunState)) &&
    (candidate.runAttempt === undefined || typeof candidate.runAttempt === 'string') &&
    (candidate.runOwner === undefined || typeof candidate.runOwner === 'string') &&
    (candidate.epoch === undefined ||
      (typeof candidate.epoch === 'string' && candidate.epoch.length > 0)) &&
    KNOWN_STATUSES.includes(candidate.status as AgentStatus)
  );
}
