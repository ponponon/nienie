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
  /** 最近一次历史补偿（onReconnect）的失败原因，便于诊断。 */
  recoveryError?: string | undefined;
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 预挂空 catch，避免「无人 await 时 reject」触发 UnhandledPromiseRejection；
  // await promise 的调用方仍会正常收到 reject。
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
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
  recoveryError?: string | undefined;
  /** 当前/下一次连接的结果；连接断开时会换新，供 waitUntilConnected 等待。 */
  connectionOutcome: Deferred<void>;
  supervisor: Promise<void>;
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
  /** 同步获取/创建 entry 并启动 supervisor，返回 entry（供捕获 connectionOutcome）。 */
  private getOrCreateEntry(key: string): Entry {
    const existing = this.entries.get(key);
    if (existing) return existing;

    const controller = new AbortController();
    const entry: Entry = {
      key,
      controller,
      state: 'connecting',
      reconnects: 0,
      receivedEvents: 0,
      connectionOutcome: createDeferred<void>(),
      supervisor: Promise.resolve(),
      closed: false,
    };
    // 先登记 entry，使 dispose/close 能中止「建立中」的连接
    this.entries.set(key, entry);
    entry.supervisor = this.supervise(entry);
    return entry;
  }

  async ensure(key: string): Promise<void> {
    if (this.disposed) {
      throw new Error('AgentEventConnectionManager disposed');
    }
    this.getOrCreateEntry(key);
  }

  /**
   * 等待某 key「当前」处于已连接状态。断线重连期间调用会一直等到重连成功，
   * 而非复用首次连接的旧 Promise（避免 sendMessage 在重连中误发 Prompt）。
   */
  async waitUntilConnected(key: string): Promise<void> {
    if (this.disposed) {
      throw new Error('AgentEventConnectionManager disposed');
    }
    // 同步捕获 connectionOutcome，避免 await 期间 supervisor 失败移除 entry
    const entry = this.getOrCreateEntry(key);
    if (entry.state === 'connected') return;
    return entry.connectionOutcome.promise;
  }

  isConnected(key: string): boolean {
    return this.entries.get(key)?.state === 'connected';
  }

  /** 结算当前 connectionOutcome（resolve/reject 各只生效一次，重复调用被 Promise 忽略）。 */
  private settle(entry: Entry, outcome: 'connected' | 'failed' | 'closed', error?: unknown): void {
    const deferred = entry.connectionOutcome;
    if (outcome === 'connected') {
      deferred.resolve();
    } else {
      deferred.reject(error instanceof Error ? error : new Error(String(error ?? outcome)));
    }
  }

  /** 后台连接监督：建立 → 消费事件 → 断线后指数退避重连。 */
  private async supervise(entry: Entry): Promise<void> {
    let attempt = 0;
    let everConnected = false;

    while (!this.disposed && !entry.closed) {
      try {
        entry.state = attempt === 0 ? 'connecting' : 'reconnecting';
        const stream = await this.options.connect(entry.key, entry.controller.signal);

        // 建连期间可能被 close/dispose，需复查
        if (this.disposed || entry.closed || entry.controller.signal.aborted) {
          this.settle(entry, 'closed', new Error('connection closed'));
          return;
        }

        entry.state = 'connected';
        entry.connectedAt = this.now();
        entry.lastError = undefined;
        this.settle(entry, 'connected');
        if (everConnected) {
          entry.reconnects++;
          try {
            await this.options.onReconnect?.(entry.key);
            entry.recoveryError = undefined;
          } catch (error) {
            // 历史补偿失败不中断实时事件消费，但记录到诊断
            entry.recoveryError = error instanceof Error ? error.message : String(error);
          }
        }
        everConnected = true;

        for await (const raw of stream) {
          if (entry.controller.signal.aborted) return;
          entry.receivedEvents++;
          entry.lastEventAt = this.now();
          try {
            this.options.onEvent(raw, entry.key);
          } catch {
            // 事件处理异常不应触发传输层重连
          }
        }
        // 流正常结束（非 abort）—— 视为断线；为下一代连接换新 Deferred
        entry.lastError = 'stream ended';
        entry.connectionOutcome = createDeferred<void>();
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : String(error);
        if (!everConnected) {
          // 首次建立失败：结算等待者 + 移除 entry，让后续可重试
          this.settle(entry, 'failed', error);
          if (this.entries.get(entry.key) === entry) {
            this.entries.delete(entry.key);
          }
          entry.state = 'failed';
          return;
        }
        // 重连暂时失败：保持当前 Deferred pending，继续重试（不提前 reject 等待者）
      }

      if (this.disposed || entry.closed || entry.controller.signal.aborted) {
        this.settle(entry, 'closed', new Error('connection closed'));
        return;
      }

      entry.state = 'reconnecting';
      attempt++;
      if (attempt > this.retry.maxReconnects) {
        entry.state = 'failed';
        this.settle(
          entry,
          'failed',
          new Error(`reconnect attempts exhausted (${this.retry.maxReconnects})`),
        );
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
        this.settle(entry, 'closed', new Error('connection closed'));
        return; // aborted
      }
      // 重连用新 controller（旧流已结束）
      if (!this.disposed && !entry.closed) {
        entry.controller = new AbortController();
      }
    }
    entry.state = entry.state === 'failed' ? 'failed' : 'closed';
    this.settle(entry, entry.state === 'failed' ? 'failed' : 'closed', new Error('connection closed'));
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
      recoveryError: entry.recoveryError,
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
    this.settle(entry, 'closed', new Error(`event stream closed: ${key}`));
    await entry.supervisor.catch(() => undefined);
  }

  /** 释放所有连接，停止重连。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      entry.closed = true;
      entry.controller.abort();
      this.settle(entry, 'closed', new Error('AgentEventConnectionManager disposed'));
    }
    // 等待后台 supervisor 循环真正退出（而非仅让出一次事件循环）
    await Promise.all(entries.map((entry) => entry.supervisor.catch(() => undefined)));
    for (const entry of entries) {
      entry.state = 'closed';
    }
  }
}
