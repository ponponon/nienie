import { describe, expect, it } from 'vitest';
import { AgentEventConnectionManager } from '../src/connections.js';

/**
 * 可控假事件流：手动推事件 / 断开，并遵守 AbortSignal 取消约定（管理器契约）。
 */
function makeSource() {
  const queue: unknown[] = [];
  let ended = false;
  let notify: (() => void) | null = null;
  return {
    push(v: unknown) {
      queue.push(v);
      notify?.();
    },
    end() {
      ended = true;
      notify?.();
    },
    stream(signal: AbortSignal): AsyncIterable<unknown> {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              while (queue.length === 0 && !ended && !signal.aborted) {
                // 等待推入 / 结束 / abort，任一发生即醒
                await new Promise<void>((resolve) => {
                  notify = resolve;
                  signal.addEventListener('abort', () => resolve(), { once: true });
                });
              }
              if (signal.aborted) throw new Error('aborted');
              if (queue.length > 0) return { done: false, value: queue.shift() };
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
}

function deferredSleep() {
  const waits: Array<{ ms: number; resolve: () => void }> = [];
  return {
    waits,
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        waits.push({ ms, resolve });
        // 遵守 AbortSignal（对齐生产 defaultSleep），否则 close/dispose 会卡在 await supervisor
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    flush() {
      while (waits.length > 0) waits.shift()!.resolve();
    },
  };
}

describe('AgentEventConnectionManager', () => {
  it('ensure 去重并发建连，只建一条，事件回调正常', async () => {
    let connectCount = 0;
    const source = makeSource();
    const events: Array<{ raw: unknown; key: string }> = [];

    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => {
        connectCount++;
        return source.stream(signal);
      },
      onEvent: (raw, key) => events.push({ raw, key }),
    });

    await Promise.all([mgr.ensure('dirA'), mgr.ensure('dirA'), mgr.ensure('dirA')]);
    await mgr.waitUntilConnected('dirA');
    expect(connectCount).toBe(1);

    source.push('e1');
    source.push('e2');
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([
      { raw: 'e1', key: 'dirA' },
      { raw: 'e2', key: 'dirA' },
    ]);

    await mgr.dispose();
  });

  it('断线后自动重连（指数退避），并触发 onReconnect 钩子', async () => {
    let connectCount = 0;
    const sources = [makeSource(), makeSource()];
    const reconnected: string[] = [];
    const events: unknown[] = [];
    const ds = deferredSleep();

    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => sources[connectCount++]!.stream(signal),
      onEvent: (raw) => events.push(raw),
      onReconnect: (key) => reconnected.push(key),
      retry: { initialDelayMs: 100, factor: 2 },
      sleep: ds.sleep,
    });

    await mgr.waitUntilConnected('dirA');
    sources[0]!.push('a1');
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['a1']);

    // 断开第一条流 → 触发重连
    sources[0]!.end();
    await new Promise((r) => setTimeout(r, 5));
    expect(ds.waits.length).toBeGreaterThanOrEqual(1);
    ds.flush();
    await new Promise((r) => setTimeout(r, 5));

    expect(connectCount).toBe(2);
    expect(reconnected).toEqual(['dirA']);

    sources[1]!.push('a2');
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['a1', 'a2']);

    await mgr.dispose();
  });

  it('已连接后断线，再调用 waitUntilConnected 必须等重连成功', async () => {
    let connectCount = 0;
    const sources = [makeSource(), makeSource()];
    const ds = deferredSleep();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => sources[connectCount++]!.stream(signal),
      onEvent: () => {},
      sleep: ds.sleep,
    });

    await mgr.waitUntilConnected('dirA');
    expect(mgr.isConnected('dirA')).toBe(true);

    sources[0]!.end();
    await new Promise((r) => setTimeout(r, 5));
    expect(mgr.isConnected('dirA')).toBe(false); // 重连中

    // 此时 waitUntilConnected 不应立即返回，而应等重连
    let resolved = false;
    const waiting = mgr.waitUntilConnected('dirA').then(() => (resolved = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false); // 还没连上

    ds.flush(); // 结束退避 → 重连成功
    await waiting;
    expect(resolved).toBe(true);
    expect(mgr.isConnected('dirA')).toBe(true);

    await mgr.dispose();
  });

  it('首次建连失败抛出，且不影响后续 ensure 重试', async () => {
    let attempt = 0;
    const source = makeSource();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => {
        attempt++;
        if (attempt === 1) throw new Error('boom');
        return source.stream(signal);
      },
      onEvent: () => {},
    });

    // 首次建连失败（waitUntilConnected 内部会 ensure）
    await expect(mgr.waitUntilConnected('dirA')).rejects.toThrow('boom');
    // 失败后可重试
    await mgr.waitUntilConnected('dirA');
    source.push('x');
    await new Promise((r) => setTimeout(r, 5));
    expect(mgr.statusFor('dirA')?.receivedEvents).toBe(1);

    await mgr.dispose();
  });

  it('dispose 中止连接、等待 supervisor 退出', async () => {
    let connectCount = 0;
    const source = makeSource();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => {
        connectCount++;
        return source.stream(signal);
      },
      onEvent: () => {},
    });

    await mgr.waitUntilConnected('dirA');
    expect(connectCount).toBe(1);

    await mgr.dispose();
    // dispose 后即使流结束也不再重连
    source.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(connectCount).toBe(1);
    expect(mgr.status()).toEqual([]);
  });

  it('dispose 抛出已中止的 waitUntilConnected', async () => {
    const source = makeSource();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => source.stream(signal),
      onEvent: () => {},
    });
    await mgr.waitUntilConnected('dirA');
    await mgr.dispose();
    await expect(mgr.ensure('dirB')).rejects.toThrow(/disposed/);
  });

  it('status 暴露状态、重连次数、事件计数', async () => {
    const source = makeSource();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => source.stream(signal),
      onEvent: () => {},
    });

    await mgr.waitUntilConnected('dirA');
    source.push('a');
    source.push('b');
    await new Promise((r) => setTimeout(r, 5));

    const diag = mgr.statusFor('dirA')!;
    expect(diag.key).toBe('dirA');
    expect(diag.state).toBe('connected');
    expect(diag.receivedEvents).toBe(2);
    expect(diag.reconnects).toBe(0);
    expect(typeof diag.connectedAt).toBe('number');

    await mgr.dispose();
  });

  it('多 key 各自独立连接、互不串扰', async () => {
    const s1 = makeSource();
    const s2 = makeSource();
    const byKey: Record<string, unknown[]> = { a: [], b: [] };
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => (key === 'a' ? s1.stream(signal) : s2.stream(signal)),
      onEvent: (raw, key) => byKey[key]!.push(raw),
    });

    await Promise.all([mgr.waitUntilConnected('a'), mgr.waitUntilConnected('b')]);
    s1.push('from-a');
    s2.push('from-b');
    await new Promise((r) => setTimeout(r, 5));

    expect(byKey.a).toEqual(['from-a']);
    expect(byKey.b).toEqual(['from-b']);
    expect(mgr.status().length).toBe(2);

    await mgr.dispose();
  });
});

describe('连接生命周期闭合（ChatGPT 第三轮 P1 验收）', () => {
  it('重连过程中连续失败，等待者不提前 reject，最终等到成功连接', async () => {
    let attempt = 0;
    const sources = [makeSource(), makeSource()];
    const ds = deferredSleep();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => {
        attempt++;
        if (attempt === 2 || attempt === 3) throw new Error('transient'); // 第2、3次重连失败
        return sources[attempt === 1 ? 0 : 1]!.stream(signal);
      },
      onEvent: () => {},
      retry: { initialDelayMs: 10, factor: 1 },
      sleep: ds.sleep,
    });

    // 第一次连接成功
    await mgr.waitUntilConnected('k');
    // 断开 → 进入重连（第2、3次失败，第4次成功）
    sources[0]!.end();
    await new Promise((r) => setTimeout(r, 5));

    let settled = false;
    let rejected = false;
    const waiting = mgr
      .waitUntilConnected('k')
      .then(() => (settled = true))
      .catch(() => (rejected = true));

    // 反复 flush 退避，让第2、3次失败、第4次成功
    for (let i = 0; i < 6; i++) {
      ds.flush();
      await new Promise((r) => setTimeout(r, 5));
      if (settled) break;
    }
    await waiting;
    // 关键：等待者最终 resolve（不因中间失败而 reject）
    expect(settled).toBe(true);
    expect(rejected).toBe(false);
    await mgr.dispose();
  });

  it('达到 maxReconnects 后等待者收到 terminal error，不永久等待', async () => {
    let attempt = 0;
    const first = makeSource();
    const ds = deferredSleep();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => {
        attempt++;
        if (attempt === 1) return first.stream(signal); // 首次成功
        throw new Error('always fail'); // 之后全失败
      },
      onEvent: () => {},
      retry: { initialDelayMs: 10, factor: 1, maxReconnects: 2 },
      sleep: ds.sleep,
    });

    await mgr.waitUntilConnected('k');
    first.end(); // 断开 → 触发重连（重连全失败）
    await new Promise((r) => setTimeout(r, 5));

    let gotError: Error | null = null;
    const waiting = mgr.waitUntilConnected('k').catch((e: Error) => (gotError = e));
    // 反复 flush 退避，让重连失败直到 maxReconnects
    for (let i = 0; i < 8; i++) {
      ds.flush();
      await new Promise((r) => setTimeout(r, 5));
      if (gotError) break;
    }
    await waiting;
    expect(gotError).not.toBeNull();
    expect(gotError!.message).toMatch(/exhausted/i);
    await mgr.dispose();
  });

  it('close 时正在等待的 waitUntilConnected 会被结束', async () => {
    const source = makeSource();
    const ds = deferredSleep();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => source.stream(signal),
      onEvent: () => {},
      sleep: ds.sleep,
    });

    await mgr.waitUntilConnected('k');
    source.end(); // 断开，进入重连（backoff 等待中）
    await new Promise((r) => setTimeout(r, 5));

    let rejected = false;
    const waiting = mgr.waitUntilConnected('k').catch(() => (rejected = true));
    await mgr.close('k'); // close 应结束等待者
    await waiting;
    expect(rejected).toBe(true);
    await mgr.dispose();
  });

  it('dispose 时正在等待的 waitUntilConnected 会被结束', async () => {
    const source = makeSource();
    const ds = deferredSleep();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => source.stream(signal),
      onEvent: () => {},
      sleep: ds.sleep,
    });

    await mgr.waitUntilConnected('k');
    source.end();
    await new Promise((r) => setTimeout(r, 5));

    let rejected = false;
    const waiting = mgr.waitUntilConnected('k').catch(() => (rejected = true));
    await mgr.dispose();
    await waiting;
    expect(rejected).toBe(true);
  });

  it('onReconnect 失败记录到 diagnostics.recoveryError，不静默吞掉', async () => {
    let connectCount = 0;
    const sources = [makeSource(), makeSource()];
    const ds = deferredSleep();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key, signal) => sources[connectCount++]!.stream(signal),
      onEvent: () => {},
      onReconnect: () => {
        throw new Error('history recovery failed');
      },
      retry: { initialDelayMs: 10 },
      sleep: ds.sleep,
    });

    await mgr.waitUntilConnected('k');
    sources[0]!.end();
    await new Promise((r) => setTimeout(r, 5));
    ds.flush();
    await new Promise((r) => setTimeout(r, 5));

    const diag = mgr.statusFor('k');
    expect(diag?.reconnects).toBeGreaterThanOrEqual(1);
    expect(diag?.recoveryError).toContain('history recovery failed');
    await mgr.dispose();
  });

  it('首次连接立即失败不产生 unhandled rejection（Deferred 预挂 catch）', async () => {
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async () => {
        throw new Error('boom');
      },
      onEvent: () => {},
    });
    // 即便无人 await，也不应触发 unhandledRejection（createDeferred 已预挂 catch）
    void mgr.ensure('k');
    await new Promise((r) => setTimeout(r, 20));
    await mgr.dispose();
  });
});
