import { describe, expect, it } from 'vitest';
import { AgentEventConnectionManager } from '../src/connections.js';

/** 可控的假事件流：手动推事件、手动断开。 */
function makeStream() {
  const queue: unknown[] = [];
  let ended = false;
  let notify: (() => void) | null = null;
  const stream: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0 && !ended) {
            await new Promise<void>((r) => (notify = r));
          }
          if (queue.length > 0) return { done: false, value: queue.shift() };
          return { done: true, value: undefined };
        },
      };
    },
  };
  return {
    stream,
    push(v: unknown) {
      queue.push(v);
      notify?.();
    },
    end() {
      ended = true;
      notify?.();
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
    const { stream, push } = makeStream();
    const events: Array<{ raw: unknown; key: string }> = [];

    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key) => {
        connectCount++;
        return stream;
      },
      onEvent: (raw, key) => events.push({ raw, key }),
    });

    // 并发 ensure 同一 key
    await Promise.all([mgr.ensure('dirA'), mgr.ensure('dirA'), mgr.ensure('dirA')]);
    expect(connectCount).toBe(1);

    push('e1');
    push('e2');
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([
      { raw: 'e1', key: 'dirA' },
      { raw: 'e2', key: 'dirA' },
    ]);

    await mgr.dispose();
  });

  it('断线后自动重连（指数退避），并触发 onReconnect 钩子', async () => {
    let connectCount = 0;
    const streams = [makeStream(), makeStream()];
    const reconnected: string[] = [];
    const events: unknown[] = [];
    const ds = deferredSleep();

    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async () => streams[connectCount++]!.stream,
      onEvent: (raw) => events.push(raw),
      onReconnect: (key) => reconnected.push(key),
      retry: { initialDelayMs: 100, factor: 2 },
      sleep: ds.sleep,
    });

    await mgr.ensure('dirA');
    streams[0]!.push('a1');
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['a1']);

    // 断开第一条流 → 触发重连
    streams[0]!.end();
    await new Promise((r) => setTimeout(r, 5));
    // supervisor 进入 backoff sleep
    expect(ds.waits.length).toBeGreaterThanOrEqual(1);
    ds.flush(); // 立即结束 backoff
    await new Promise((r) => setTimeout(r, 5));

    expect(connectCount).toBe(2); // 重连成功
    expect(reconnected).toEqual(['dirA']);

    streams[1]!.push('a2');
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['a1', 'a2']);

    await mgr.dispose();
  });

  it('首次建连失败抛出，且不影响后续 ensure 重试', async () => {
    let attempt = 0;
    const { stream, push } = makeStream();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async () => {
        attempt++;
        if (attempt === 1) throw new Error('boom');
        return stream;
      },
      onEvent: () => {},
    });

    await expect(mgr.ensure('dirA')).rejects.toThrow('boom');
    // 失败后 entry 已移除，可重试
    await mgr.ensure('dirA');
    push('x');
    await new Promise((r) => setTimeout(r, 5));
    expect(mgr.statusFor('dirA')?.receivedEvents).toBe(1);

    await mgr.dispose();
  });

  it('dispose 中止连接、停止重连', async () => {
    let connectCount = 0;
    const { stream, end } = makeStream();
    const ds = deferredSleep();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async () => {
        connectCount++;
        return stream;
      },
      onEvent: () => {},
      sleep: ds.sleep,
    });

    await mgr.ensure('dirA');
    expect(connectCount).toBe(1);

    await mgr.dispose();
    // dispose 后即使流结束也不再重连
    end();
    await new Promise((r) => setTimeout(r, 10));
    expect(connectCount).toBe(1);
    expect(mgr.status()).toEqual([]);
  });

  it('status 暴露状态、重连次数、事件计数', async () => {
    const { stream, push } = makeStream();
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async () => stream,
      onEvent: () => {},
    });

    await mgr.ensure('dirA');
    push('a');
    push('b');
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
    const s1 = makeStream();
    const s2 = makeStream();
    const byKey: Record<string, unknown[]> = { a: [], b: [] };
    const mgr = new AgentEventConnectionManager<unknown>({
      connect: async (key) => (key === 'a' ? s1.stream : s2.stream),
      onEvent: (raw, key) => byKey[key]!.push(raw),
    });

    await Promise.all([mgr.ensure('a'), mgr.ensure('b')]);
    s1.push('from-a');
    s2.push('from-b');
    await new Promise((r) => setTimeout(r, 5));

    expect(byKey.a).toEqual(['from-a']);
    expect(byKey.b).toEqual(['from-b']);
    expect(mgr.status().length).toBe(2);

    await mgr.dispose();
  });
});
