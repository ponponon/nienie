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

describe('Codex 真实事件归并（无 partId）', () => {
  it('Round 3：tool_use/tool_result 按 toolCallId 落同一 Part，exitCode 不丢', () => {
    const store = new InMemorySessionStateStore({
      agentId: 'codex',
      streamEpoch: 'ep1',
    });
    // 真实 Codex 事件形态：不带 partId
    store.applyEvent(
      evt(1, 'tool_use', { toolCallId: 'cmd_2', name: 'bash', input: { command: 'exit 2' } }),
    );
    store.applyEvent(
      evt(2, 'tool_result', { toolCallId: 'cmd_2', content: 'boom', isError: true, exitCode: 2 }),
    );

    const snap = store.createSnapshot('ses_1');
    const tools = snap.parts.filter((p) => p.kind === 'tool_call');
    expect(tools).toHaveLength(1); // 不生成两个碎片 Part
    const tool = tools[0]!;
    if (tool.kind !== 'tool_call') throw new Error('unreachable');
    expect(tool.status).toBe('failed');
    expect(tool.exitCode).toBe(2); // exitCode 保留
    expect(tool.toolStartedAt).toBeDefined(); // tool_use 时刻=真实开始
    expect(tool.toolFinishedAt).toBeDefined(); // tool_result 时刻=真实完成
  });
});
