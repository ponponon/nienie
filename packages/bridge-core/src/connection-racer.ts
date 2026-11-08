/**
 * 连接竞速器（Connection Racer）—— Nienie 多级网络调度的「大脑」。
 *
 * 对标 RustDesk 的 `race_transports_prefer_webrtc`：多路传输并行竞速，
 * **直连（LAN / P2P 打洞，0 带宽）立即胜出**，中继（Relay，占用服务器带宽）结果**挂起 `windowMs`**，
 * 给仍在尝试的直连留机会；窗口内直连成功则丢弃中继，超时才认输用中继。这正是「省带宽」的核心。
 *
 * 传输分级（0 带宽优先）：
 *   lan  —— 同内网直连（最快、0 带宽）
 *   p2p  —— UDP 打洞 QUIC 直连（0 带宽）
 *   relay —— 服务器中继兜底（占用带宽，万不得已才用）
 *
 * 取消语义：任一结果被提交（`finish`）后，其余分支通过各自 `AbortSignal` 被取消，
 * 与 `QuicP2PNode.connect(peer, { signal })` 的取消闭环配套。
 */

export type TransportKind = 'lan' | 'p2p' | 'relay';

export type TransportCandidate<T> = {
  kind: TransportKind;
  /** 建立该传输的尝试（接收可取消信号，供竞速失败分支中止）。 */
  run: (signal: AbortSignal) => Promise<T>;
};

export type RaceOptions = {
  /** 直连仍可能到达时，中继结果挂起等待的窗口（毫秒）。 */
  windowMs?: number;
  /** 外部取消（如用户主动断开），将中止所有分支并拒绝。 */
  signal?: AbortSignal;
};

/** 直连（0 带宽）相对中继优先：LAN 与 P2P 都是直连。 */
function isDirect(kind: TransportKind): boolean {
  return kind === 'lan' || kind === 'p2p';
}

/**
 * 多路并行竞速，直连胜出优先、中继挂起让位。
 *
 * 决策语义（与 RustDesk 对齐）：
 *  - 任一直连（lan/p2p）成功 → 立即提交，取消其余分支。
 *  - 中继成功但仍有直连在途 → 挂起，等 `windowMs` 内的直连；窗口内直连成功则丢弃中继。
 *  - `windowMs` 到期仍有挂起中继 → 提交该中继。
 *  - 全部分支失败且无挂起中继 → 抛出首个失败原因。
 */
export function raceTransports<T>(
  candidates: Array<TransportCandidate<T>>,
  options: RaceOptions = {},
): Promise<T> {
  const { windowMs = 500, signal } = options;

  if (candidates.length === 0) {
    return Promise.reject(new Error('raceTransports: no transport candidates'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let held: T | undefined;
    let windowTimer: ReturnType<typeof setTimeout> | undefined;
    const aborts: AbortController[] = [];

    // 统计在途分支，用于判断「是否还有直连能赢」
    let pendingTotal = candidates.length;
    let pendingDirect = candidates.filter((c) => isDirect(c.kind)).length;
    const failures: unknown[] = [];

    const cleanup = () => {
      if (windowTimer) clearTimeout(windowTimer);
      for (const ac of aborts) ac.abort();
    };

    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    // 外部取消：中止所有分支
    const onAbort = () => fail(new Error('raceTransports: aborted'));
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    for (const candidate of candidates) {
      const ac = new AbortController();
      aborts.push(ac);

      candidate
        .run(ac.signal)
        .then((value) => {
          pendingTotal--;
          if (isDirect(candidate.kind)) {
            pendingDirect--;
            // 直连立即胜出：丢弃任何挂起中继，取消其余分支
            finish(value);
            return;
          }
          // 中继成功
          if (pendingDirect === 0 && pendingTotal === 0) {
            // 已无任何直连能赢 → 直接认投中继
            finish(value);
          } else if (held === undefined) {
            // 仍有直连在途 → 挂起中继，开窗口给直连留机会
            held = value;
            windowTimer = setTimeout(() => {
              if (held !== undefined) finish(held);
            }, windowMs);
          }
          // 若已有挂起中继则丢弃后续中继（首个挂起者胜出）
        })
        .catch((err) => {
          pendingTotal--;
          if (isDirect(candidate.kind)) pendingDirect--;
          failures.push(err);
          if (pendingTotal === 0 && pendingDirect === 0) {
            // 所有分支终结：有挂起中继就用它，否则报错
            if (held !== undefined) finish(held);
            else fail(failures[0] ?? new Error('raceTransports: all transports failed'));
          }
        });
    }
  });
}
