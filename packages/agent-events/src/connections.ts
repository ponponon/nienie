/**
 * AgentEventConnectionManager —— transport-agnostic 的事件流连接生命周期管理。
 *
 * 统一管理「建立 / 去重 / 断线重连 / 释放」，供各 Agent 适配器复用，避免每个适配器
 * 各自重解一遍断线与丢事件问题。输入是 `AsyncIterable<unknown>`：
 * OpenCode/MiMo 的 SSE 解析流、Codex/Claude Code 的子进程 stdout 行流、
 * SQLite 历史行流都能套同一套语义。
 *
 * 职责：
 * - `ensure(key)`：确保某 key（如 directory）的事件流已建立，去重并发建连。
 * - 断线（流结束/报错）后按指数退避 + 抖动自动重连。
 * - `onReconnect` 钩子：重连成功后回调，供适配器做事件历史补偿。
 * - `status()`：暴露每条连接的诊断信息（状态 / 重连次数 / 最后事件时间）。
 * - `close(key)` / `dispose()`：显式关闭与整体释放。
 */

export type EventStreamState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'failed';

export interface EventStreamDiagnostics {
  key: string;
  state: EventStreamState;
  connectedAt?: number | undefined;
  lastEventAt?: number | undefined;
  reconnects: number;
  receivedEvents: number;
  lastError?: string | undefined;
}

export interface RetryPolicy {
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  maxReconnects?: number;
}

export interface AgentEventConnectionManagerOptions<T> {
  /** 建立某 key 的事件流，返回 raw 事件的 AsyncIterable；signal 用于取消。 */
  connect: (key: string, signal: AbortSignal) => Promise<AsyncIterable<T>>;
  /** 每个 raw 事件回调。 */
  onEvent: (raw: T, key: string) => void;
  /** 重连成功后回调，供适配器做事件历史补偿。 */
  onReconnect?: ((key: string) => void) | undefined;
  retry?: RetryPolicy | undefined;
  /** 测试注入时钟。 */
  now?: (() => number) | undefined;
  /** 测试注入 sleep（可被 signal 中止）。 */
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

interface Entry {
  key: string;
  controller: AbortController;
  state: EventStreamState;
  connectedAt?: number | undefined;
  lastEventAt?: number | undefined;
  reconnects: number;
  receivedEvents: number;
  lastError?: string | undefined;
  ready: Promise<void>;
  closed: boolean;
}

const DEFAULT_RETRY: Required<RetryPolicy> = {
  initialDelayMs: 500,
  maxDelayMs: 15_000,
  factor: 2,
  maxReconnects: Number.POSITIVE_INFINITY,
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class AgentEventConnectionManager<T> {
  private readonly entries = new Map<string, Entry>();
  private readonly options: AgentEventConnectionManagerOptions<T>;
  private readonly retry: Required<RetryPolicy>;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private disposed = false;

  constructor(options: AgentEventConnectionManagerOptions<T>) {
    this.options = options;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * 确保某 key 的事件流已建立。去重并发调用；重复调用已连接的 key 直接返回。
   * 首次建立失败会抛出（供 sendMessage 强一致使用）；建立后断线由后台自动重连。
   */
  async ensure(key: string): Promise<void> {
    if (this.disposed) return;
    const existing = this.entries.get(key);
    if (existing) {
      return existing.ready;
    }

    const controller = new AbortController();
    const entry: Entry = {
      key,
      controller,
      state: 'connecting',
      reconnects: 0,
      receivedEvents: 0,
      ready: Promise.resolve(),
      closed: false,
    };
    // 先登记 entry，使 dispose/close 能中止「建立中」的连接
    this.entries.set(key, entry);

    // ready 只反映「首次建立」成功与否；后续重连在 supervisor 里后台进行
    let firstResolve!: () => void;
    let firstReject!: (e: unknown) => void;
    const first = new Promise<void>((resolve, reject) => {
      firstResolve = resolve;
      firstReject = reject;
    });
    entry.ready = first;

    void this.supervise(entry, firstResolve, firstReject);
    return first;
  }

  /** 后台连接监督：建立 → 消费事件 → 断线后指数退避重连。 */
  private async supervise(
    entry: Entry,
    firstResolve: () => void,
    firstReject: (e: unknown) => void,
  ): Promise<void> {
    let attempt = 0;
    let firstSettled = false;

    while (!this.disposed && !entry.closed) {
      try {
        entry.state = attempt === 0 ? 'connecting' : 'reconnecting';
        const stream = await this.options.connect(entry.key, entry.controller.signal);
        entry.state = 'connected';
        entry.connectedAt = this.now();
        entry.lastError = undefined;
        if (!firstSettled) {
          firstSettled = true;
          firstResolve();
        }
        if (attempt > 0) {
          entry.reconnects++;
          this.options.onReconnect?.(entry.key);
        }

        for await (const raw of stream) {
          if (entry.controller.signal.aborted) return;
          entry.receivedEvents++;
          entry.lastEventAt = this.now();
          this.options.onEvent(raw, entry.key);
        }
        // 流正常结束（非 abort）—— 视为断线，走重连
        entry.lastError = 'stream ended';
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : String(error);
        if (!firstSettled) {
          firstSettled = true;
          firstReject(error);
          // 首次建立失败：移除 entry，让后续 ensure 可重试
          if (this.entries.get(entry.key) === entry) {
            this.entries.delete(entry.key);
          }
          entry.state = 'failed';
          return;
        }
      }

      if (this.disposed || entry.closed || entry.controller.signal.aborted) {
        return;
      }

      attempt++;
      if (attempt > this.retry.maxReconnects) {
        entry.state = 'failed';
        return;
      }
      const delay = Math.min(
        this.retry.initialDelayMs * Math.pow(this.retry.factor, attempt - 1),
        this.retry.maxDelayMs,
      );
      const jitter = Math.floor(Math.random() * (delay * 0.2));
      try {
        await this.sleep(delay + jitter, entry.controller.signal);
      } catch {
        return; // aborted
      }
      // 重连用新 controller（旧流已结束）
      if (!this.disposed && !entry.closed) {
        entry.controller = new AbortController();
      }
    }
    if (entry.state !== 'failed') {
      entry.state = 'closed';
    }
  }

  /** 全部连接的诊断信息。 */
  status(): EventStreamDiagnostics[] {
    return [...this.entries.values()].map((e) => this.toDiagnostics(e));
  }

  statusFor(key: string): EventStreamDiagnostics | undefined {
    const entry = this.entries.get(key);
    return entry ? this.toDiagnostics(entry) : undefined;
  }

  private toDiagnostics(entry: Entry): EventStreamDiagnostics {
    return {
      key: entry.key,
      state: entry.state,
      connectedAt: entry.connectedAt,
      lastEventAt: entry.lastEventAt,
      reconnects: entry.reconnects,
      receivedEvents: entry.receivedEvents,
      lastError: entry.lastError,
    };
  }

  /** 显式关闭某 key 的连接（不再自动重连）。 */
  async close(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.closed = true;
    entry.controller.abort();
    this.entries.delete(key);
    entry.state = 'closed';
  }

  /** 释放所有连接，停止重连。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      entry.closed = true;
      entry.controller.abort();
    }
    // 让 supervisor 循环退出（sleep 被 abort）
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const entry of entries) {
      entry.state = 'closed';
    }
  }
}
