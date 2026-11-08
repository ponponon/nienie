/**
 * 连接竞速器（Connection Racer）—— Nienie 多级网络调度的「大脑」。
 *
 * 对标 RustDesk 的 `race_transports_prefer_webrtc`：多路传输并行竞速，
 * **直连（LAN / P2P 打洞，0 带宽）立即胜出**，中继（Relay，占用服务器带宽）结果**挂起 `windowMs`**，
 * 给仍在尝试的直连留机会；窗口内直连成功则丢弃中继，超时才认输用中继。
 *
 * 核心生产不变量（ChatGPT 2026-11-08 review 确立）：
 *   **任一时序下，最终只保留一个可用连接，其余连接都必须被正确终止与回收。**
 *   - 胜者绝不被 abort（否则返回的连接会立即被销毁）。
 *   - 落败的中继 / 迟到成功的连接必须显式 `close()`（仅靠 AbortSignal 不够）。
 *   - 没有直连在途时，立即提交中继（不空等窗口）。
 *
 * 资源契约：候选结果必须实现 `ClosableTransport.close()`，竞速器负责回收所有非胜者。
 */

export type TransportKind = 'lan' | 'p2p' | 'relay';

/** 竞速结果必须可关闭 —— 竞速器据此回收落败 / 迟到的连接。 */
export interface ClosableTransport {
  close(): Promise<void>;
}

export type TransportCandidate<T extends ClosableTransport> = {
  kind: TransportKind;
  /** 建立该传输的尝试（接收可取消信号，供未完成分支中止）。 */
  run: (signal: AbortSignal) => Promise<T>;
};

export type RaceOptions = {
  /** 直连仍可能到达时，中继结果挂起等待的窗口（毫秒）。 */
  windowMs?: number;
  /** 竞速整体超时，避免所有候选永久 pending（毫秒）。 */
  overallTimeoutMs?: number;
  /** 外部取消（如用户主动断开），将中止所有分支并拒绝。 */
  signal?: AbortSignal;
  /** 落败连接回收失败时的回调（不传则 console.error）。 */
  onCleanupError?: (error: unknown) => void;
};

/** 直连（0 带宽）相对中继优先：LAN 与 P2P 都是直连。 */
function isDirect(kind: TransportKind): boolean {
  return kind === 'lan' || kind === 'p2p';
}

/**
 * 多路并行竞速，直连胜出优先、中继挂起让位、失败/迟到分支回收。
 *
 * 决策语义（与 RustDesk 对齐）：
 *  - 任一直连（lan/p2p）成功 → 立即提交，中止在途分支、关闭落败中继。
 *  - 中继成功但仍有直连在途 → 挂起，等 `windowMs` 内的直连；窗口内直连成功则关闭中继。
 *  - 已无直连在途 → 立即提交中继（不空等窗口）。
 *  - `windowMs` / `overallTimeoutMs` 到期 → 提交挂起中继，否则报错。
 *  - 迟到成功的连接（忽略 abort）→ 立即 `close()` 回收。
 */
export function raceTransports<T extends ClosableTransport>(
  candidates: ReadonlyArray<TransportCandidate<T>>,
  options: RaceOptions = {},
): Promise<T> {
  const {
    windowMs = 500,
    overallTimeoutMs = 12000,
    signal,
    onCleanupError,
  } = options;

  if (candidates.length === 0) {
    return Promise.reject(new Error('raceTransports: no transport candidates'));
  }
  if (
    !Number.isFinite(windowMs) ||
    windowMs < 0 ||
    !Number.isFinite(overallTimeoutMs) ||
    overallTimeoutMs <= 0
  ) {
    return Promise.reject(new RangeError('raceTransports: invalid timeout'));
  }
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('raceTransports: aborted'));
  }

  return new Promise<T>((resolve, reject) => {
    const controllers = candidates.map(() => new AbortController());
    const pending = new Set<number>(candidates.map((_, i) => i));
    let pendingDirect = candidates.filter((c) => isDirect(c.kind)).length;

    let settled = false;
    let held: { index: number; value: T } | undefined;
    let windowTimer: ReturnType<typeof setTimeout> | undefined;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const failures: unknown[] = [];

    // 回收非胜者的连接（后台执行，不阻塞竞速结果返回）。
    const discard = (value: T) => {
      void Promise.resolve()
        .then(() => value.close())
        .catch((error: unknown) => {
          if (onCleanupError) onCleanupError(error);
          else console.error('raceTransports: transport cleanup failed', error);
        });
    };

    const clearTimers = () => {
      if (windowTimer !== undefined) clearTimeout(windowTimer);
      if (overallTimer !== undefined) clearTimeout(overallTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    // 仅中止「仍在途」的分支；胜者与已完成连接不受影响。
    const abortPending = () => {
      for (const index of pending) {
        controllers[index]!.abort();
      }
    };

    // 胜者提交：绝不 abort 胜者；关闭落败的 held 中继。
    const finish = (index: number, value: T) => {
      if (settled) {
        discard(value); // 迟到成功 → 回收
        return;
      }
      settled = true;
      clearTimers();
      abortPending();
      if (held && held.index !== index) {
        discard(held.value); // 落败中继 → 关闭
        held = undefined;
      }
      resolve(value);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      abortPending();
      if (held) {
        discard(held.value); // 无胜者 → 关闭挂起中继
        held = undefined;
      }
      reject(error);
    };

    // 所有分支终结时的收尾：有挂起中继立即用它，否则报错。
    const checkCompletion = () => {
      if (settled) return;
      if (held && pendingDirect === 0) {
        // 已无直连能赢 → 不再空等窗口
        finish(held.index, held.value);
        return;
      }
      if (pending.size === 0) {
        fail(new AggregateError(failures, 'raceTransports: all transports failed'));
      }
    };

    const onAbort = () => fail(signal?.reason ?? new Error('raceTransports: aborted'));
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    overallTimer = setTimeout(() => {
      if (held) finish(held.index, held.value);
      else fail(new Error('raceTransports: overall timeout'));
    }, overallTimeoutMs);

    candidates.forEach((candidate, index) => {
      const controller = controllers[index]!;
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return candidate.run(controller.signal);
        })
        .then(
          (value) => {
            pending.delete(index);
            if (isDirect(candidate.kind)) pendingDirect--;

            // 迟到成功（竞速已结束 / 忽略 abort）→ 立即回收
            if (settled) {
              discard(value);
              return;
            }

            if (isDirect(candidate.kind)) {
              // 直连立即胜出
              finish(index, value);
              return;
            }

            // 中继成功
            if (held) {
              // 保留首个挂起中继，后续中继回收（与 RustDesk 一致：不因新中继刷新窗口）
              discard(value);
              return;
            }
            if (pendingDirect === 0) {
              // 已无直连在途 → 立即提交，不空等窗口
              finish(index, value);
              return;
            }
            // 仍有直连在途 → 挂起，开窗口给直连留机会
            held = { index, value };
            windowTimer = setTimeout(() => {
              if (!settled && held) finish(held.index, held.value);
            }, windowMs);
          },
          (error: unknown) => {
            pending.delete(index);
            if (isDirect(candidate.kind)) pendingDirect--;
            if (settled) return;
            failures.push(error);
            checkCompletion();
          },
        )
        .catch((error: unknown) => {
          // 编排层非预期错误（非候选本身失败）
          fail(error);
        });
    });
  });
}
