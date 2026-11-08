/**
 * 连接竞速器（Connection Racer）测试 —— Nienie 多级网络调度「大脑」。
 *
 * ChatGPT (2026-11-08) review 核心洞察：生产不变量是「任一时序下最终只保留一个可用连接，
 * 其余都被正确终止与回收」，而非仅比对返回了哪条路径。因此测试用带 `close()` 的模拟连接，
 * 验证资源生命周期（胜者不被 abort / 不被关闭；落败者被关闭）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  raceTransports,
  type ClosableTransport,
  type TransportCandidate,
} from '../src/connection-racer.js';

type MockConn = ClosableTransport & { id: string; closed: boolean; closeCount: number };

function mockConnection(id: string): MockConn {
  return {
    id,
    closed: false,
    closeCount: 0,
    async close() {
      this.closed = true;
      this.closeCount++;
    },
  };
}

function delay<T>(ms: number, value: T, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

// 忽略 abort 的候选：即使被取消也照常产生连接（模拟不响应取消的适配器），
// 用于验证「落败 / 迟到产生的连接被 close() 回收」。
function delayIgnoringAbort<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function candidate(kind: TransportCandidate<MockConn>['kind'], conn: MockConn, ms: number): TransportCandidate<MockConn> {
  return { kind, run: (signal) => delay(ms, conn, signal) };
}

describe('raceTransports（资源生命周期不变量）', () => {
  it('胜者绝不被 abort、绝不被关闭（防回归：旧实现会 abort 胜者）', async () => {
    const winner = mockConnection('p2p');
    let winnerAborted = false;
    const c: TransportCandidate<MockConn> = {
      kind: 'p2p',
      run: async (signal) => {
        signal.addEventListener('abort', () => {
          winnerAborted = true;
        });
        return winner;
      },
    };
    const result = await raceTransports([c], { windowMs: 500 });
    expect(result).toBe(winner);
    expect(winnerAborted).toBe(false);
    expect(winner.closed).toBe(false);
    expect(winner.closeCount).toBe(0);
    await result.close();
    expect(winner.closeCount).toBe(1);
  });

  it('直连窗口内胜出时，先到的中继必须被关闭（回收）', async () => {
    const relay = mockConnection('relay');
    const p2p = mockConnection('p2p');
    const result = await raceTransports(
      [candidate('relay', relay, 10), candidate('p2p', p2p, 50)],
      { windowMs: 200 },
    );
    expect(result).toBe(p2p);
    await new Promise((r) => setTimeout(r, 10));
    expect(p2p.closed).toBe(false); // 胜者不关
    expect(relay.closeCount).toBe(1); // 落败中继被关
  });

  it('直连超过窗口则认投中继，迟到直连产生的连接被回收', async () => {
    const relay = mockConnection('relay');
    const p2p = mockConnection('p2p');
    // p2p 忽略 abort，窗口到期后（迟到）才产生连接 → 必须被回收
    const lateDirect: TransportCandidate<MockConn> = {
      kind: 'p2p',
      run: () => delayIgnoringAbort(60, p2p),
    };
    const result = await raceTransports(
      [candidate('relay', relay, 10), lateDirect],
      { windowMs: 5 },
    );
    expect(result).toBe(relay);
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.closed).toBe(false); // 胜者中继不关
    expect(p2p.closeCount).toBe(1); // 迟到直连产生的连接被回收
  });

  it('已无直连在途时立即提交中继（不空等窗口）', async () => {
    const failDirect: TransportCandidate<MockConn> = {
      kind: 'p2p',
      run: (signal) =>
        delay(5, mockConnection('x'), signal).then(() => Promise.reject(new Error('punch fail'))),
    };
    const relay = mockConnection('relay');
    const start = Date.now();
    const result = await raceTransports(
      [failDirect, candidate('relay', relay, 10)],
      { windowMs: 5000 }, // 窗口很大，但因无直连在途应立即提交
    );
    expect(result).toBe(relay);
    expect(Date.now() - start).toBeLessThan(1000); // 远小于 windowMs
  });

  it('多中继：保留首个成功的，后到中继产生的连接被回收', async () => {
    const relayA = mockConnection('relayA');
    const relayB = mockConnection('relayB');
    const p2pFail: TransportCandidate<MockConn> = {
      kind: 'p2p',
      run: (signal) =>
        delay(5, mockConnection('x'), signal).then(() => Promise.reject(new Error('fail'))),
    };
    // relayB 忽略 abort，晚于 relayA 产生连接 → 必须被回收
    const lateRelayB: TransportCandidate<MockConn> = {
      kind: 'relay',
      run: () => delayIgnoringAbort(20, relayB),
    };
    const result = await raceTransports(
      [p2pFail, candidate('relay', relayA, 10), lateRelayB],
      { windowMs: 5 },
    );
    expect(result).toBe(relayA); // 首个成功中继胜出（与 RustDesk 一致）
    await new Promise((r) => setTimeout(r, 50));
    expect(relayB.closeCount).toBe(1); // 后到中继被回收
    expect(relayA.closed).toBe(false);
  });

  it('忽略 AbortSignal 迟到成功的连接会被立即回收', async () => {
    let lateResolve: (c: MockConn) => void;
    const lateConn = mockConnection('late');
    const stubbornRelay: TransportCandidate<MockConn> = {
      kind: 'relay',
      run: (signal) =>
        new Promise<MockConn>((resolve, reject) => {
          lateResolve = resolve;
          signal.addEventListener('abort', () => {
            /* 忽略 abort，模拟不响应取消的适配器 */
          }, { once: true });
        }),
    };
    const p2p = mockConnection('p2p');
    const promise = raceTransports(
      [stubbornRelay, candidate('p2p', p2p, 10)],
      { windowMs: 10 },
    );
    const winner = await promise;
    expect(winner).toBe(p2p);
    // 中继迟到成功（竞速已结束）
    lateResolve!(lateConn);
    await new Promise((r) => setTimeout(r, 10));
    expect(lateConn.closeCount).toBe(1); // 迟到连接被回收
  });

  it('外部 AbortSignal 取消并回收 held 中继', async () => {
    const controller = new AbortController();
    const relay = mockConnection('relay');
    const neverDirect: TransportCandidate<MockConn> = {
      kind: 'p2p',
      run: () => new Promise<MockConn>(() => {}), // 永不 settle
    };
    const promise = raceTransports([neverDirect, candidate('relay', relay, 5)], {
      windowMs: 5000,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 20)); // 让中继先到并 held
    controller.abort();
    await expect(promise).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(relay.closeCount).toBe(1); // held 中继被回收
  });

  it('candidate.run 同步抛异常也走统一清理', async () => {
    const throwing: TransportCandidate<MockConn> = {
      kind: 'p2p',
      run: () => {
        throw new Error('sync throw');
      },
    };
    await expect(raceTransports([throwing], { windowMs: 100 })).rejects.toThrow();
  });

  it('全部分支失败且无中继时抛出 AggregateError', async () => {
    const failing: TransportCandidate<MockConn> = {
      kind: 'p2p',
      run: (signal) => delay(5, mockConnection('x'), signal).then(() => Promise.reject(new Error('boom'))),
    };
    await expect(raceTransports([failing], { windowMs: 100 })).rejects.toThrow();
  });

  it('总体超时阻止永久 pending', async () => {
    const neverRelay: TransportCandidate<MockConn> = {
      kind: 'relay',
      run: () => new Promise<MockConn>(() => {}),
    };
    await expect(
      raceTransports([neverRelay], { windowMs: 50, overallTimeoutMs: 100 }),
    ).rejects.toThrow(/timeout/i);
  });

  it('外部 signal 调用前已取消则不启动任何候选', async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    const c: TransportCandidate<MockConn> = {
      kind: 'p2p',
      run: async () => {
        started = true;
        return mockConnection('x');
      },
    };
    await expect(
      raceTransports([c], { windowMs: 100, signal: controller.signal }),
    ).rejects.toThrow();
    expect(started).toBe(false);
  });

  it('空候选拒绝', async () => {
    await expect(raceTransports([])).rejects.toThrow(/no transport candidates/);
  });
});
