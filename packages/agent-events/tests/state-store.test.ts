import { describe, expect, it } from 'vitest';
import { InMemorySessionStateStore, createSessionSerialExecutor } from '../src/state-store.js';
import type { CanonicalAgentEvent } from '@nienie/protocol';

function evt(seq: number, type: string, payload: Record<string, unknown>): CanonicalAgentEvent {
  return {
    version: 1,
    eventId: `e${seq}`,
    streamEpoch: 'ep1',
    sessionId: 'ses_1',
    sequence: seq,
    timestamp: new Date().toISOString(),
    type: type as CanonicalAgentEvent['type'],
    payload,
  } as CanonicalAgentEvent;
}

describe('InMemorySessionStateStore（Snapshot 是状态）', () => {
  it('applyEvent 更新 Part 状态与 watermark，createSnapshot 不消耗 sequence', () => {
    const store = new InMemorySessionStateStore({ agentId: 'opencode', streamEpoch: 'ep1' });
    store.applyEvent(evt(1, 'text_delta', { delta: 'Hello', partId: 'p1', revision: 1, role: 'user' }));
    store.applyEvent(evt(2, 'text_delta', { delta: ' World', partId: 'p2', revision: 1 }));
    expect(store.getLastAppliedSequence('ses_1')).toBe(2);
    const before = store.getLastAppliedSequence('ses_1');
    const snap = store.createSnapshot('ses_1');
    expect(snap.watermark).toBe(2); // watermark 是状态，不是消耗的 sequence
    expect(store.getLastAppliedSequence('ses_1')).toBe(before); // createSnapshot 不改 sequence
    expect(snap.parts.length).toBe(2);
    expect(snap.complete).toBe(true);
    expect(snap.hasMore).toBe(false);
  });

  it('tool_use/tool_result 合并为单个 tool_call Part 状态', () => {
    const store = new InMemorySessionStateStore({ agentId: 'opencode', streamEpoch: 'ep1' });
    store.applyEvent(evt(1, 'tool_use', { toolCallId: 'c1', name: 'bash', input: { command: 'ls' }, partId: 'c1' }));
    store.applyEvent(evt(2, 'tool_result', { toolCallId: 'c1', content: 'ok', isError: false, partId: 'c1' }));
    const snap = store.createSnapshot('ses_1');
    const tool = snap.parts.find((p) => p.kind === 'tool_call');
    expect(tool && tool.kind === 'tool_call' ? tool.status : '').toBe('completed');
    expect(tool && tool.kind === 'tool_call' ? tool.output : '').toBe('ok');
  });

  it('串行执行器：同一 Session 顺序执行，不交叉', async () => {
    const ex = createSessionSerialExecutor();
    const order: number[] = [];
    await Promise.all([
      ex.run('s', async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); }),
      ex.run('s', async () => { order.push(2); }),
      ex.run('s', async () => { order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });
});
