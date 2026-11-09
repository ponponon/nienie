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
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waits.push({ ms, resolve });
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
