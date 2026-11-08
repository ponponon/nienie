/**
 * 连接竞速器（Connection Racer）测试 —— Nienie 多级网络调度「大脑」。
 *
 * 锁定 RustDesk 式决策语义：
 *  - 直连（lan/p2p）成功立即胜出、取消其余分支（0 带宽优先于中继）。
 *  - 中继成功但直连在途 → 挂起 `windowMs` 窗口，窗口内直连成功则丢弃中继。
 *  - 窗口到期 → 提交挂起中继（万不得已才用带宽）。
 *  - 全失败且无中继 → 报错；外部 AbortSignal → 取消全部分支。
 */
import { describe, expect, it } from 'vitest';
import { raceTransports, type TransportCandidate } from '../src/connection-racer.js';

function delay<T>(ms: number, value: T, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function direct(value: string, ms: number): TransportCandidate<string> {
  return { kind: 'p2p', run: (signal) => delay(ms, value, signal) };
}
function lan(value: string, ms: number): TransportCandidate<string> {
  return { kind: 'lan', run: (signal) => delay(ms, value, signal) };
}
function relay(value: string, ms: number): TransportCandidate<string> {
  return { kind: 'relay', run: (signal) => delay(ms, value, signal) };
}

describe('raceTransports（直连优先、中继挂起）', () => {
  it('窗口内直连成功则胜出，丢弃先到的中继', async () => {
    // 中继 10ms 先到 → 挂起；直连 50ms 在 200ms 窗口内到达 → 直连胜出
    const result = await raceTransports([relay('RELAY', 10), direct('P2P', 50)], {
      windowMs: 200,
    });
    expect(result).toBe('P2P');
  });

  it('直连超过窗口则认投中继（万不得已才用带宽）', async () => {
    // 中继 10ms 挂起，窗口 5ms 到期 → 中继胜出，慢直连(50ms)被取消
    const result = await raceTransports([relay('RELAY', 10), direct('P2P', 50)], {
      windowMs: 5,
    });
    expect(result).toBe('RELAY');
  });

  it('LAN 与 P2P 同属直连，任一成功即胜出且快者优先', async () => {
    const result = await raceTransports(
      [relay('RELAY', 5), lan('LAN', 15), direct('P2P', 30)],
      { windowMs: 200 },
    );
    expect(result).toBe('LAN'); // 直连中最快者胜出
  });

  it('所有直连失败时兜底到中继', async () => {
    const failingDirect: TransportCandidate<string> = {
      kind: 'p2p',
      run: (signal) =>
        delay(5, 'x', signal).then(() => Promise.reject(new Error('punch failed'))),
    };
    const result = await raceTransports([failingDirect, relay('RELAY', 10)], {
      windowMs: 200,
    });
    expect(result).toBe('RELAY');
  });

  it('全部分支失败且无中继时抛出错误', async () => {
    const failing: TransportCandidate<string> = {
      kind: 'p2p',
      run: (signal) => delay(5, 'x', signal).then(() => Promise.reject(new Error('boom'))),
    };
    await expect(raceTransports([failing], { windowMs: 100 })).rejects.toThrow('boom');
  });

  it('直连胜出后取消其余分支（释放资源）', async () => {
    let relayAborted = false;
    const slowRelay: TransportCandidate<string> = {
      kind: 'relay',
      run: (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => {
            relayAborted = true;
            reject(new Error('aborted'));
          });
        }),
    };
    const result = await raceTransports([slowRelay, direct('P2P', 10)], { windowMs: 500 });
    expect(result).toBe('P2P');
    // 直连胜出会 abort 其余分支的信号
    await new Promise((r) => setTimeout(r, 10));
    expect(relayAborted).toBe(true);
  });

  it('外部 AbortSignal 取消全部分支', async () => {
    const controller = new AbortController();
    const neverRelay: TransportCandidate<string> = {
      kind: 'relay',
      run: (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const promise = raceTransports([neverRelay], {
      windowMs: 5000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('无候选时拒绝', async () => {
    await expect(raceTransports([], {})).rejects.toThrow(/no transport candidates/);
  });
});
