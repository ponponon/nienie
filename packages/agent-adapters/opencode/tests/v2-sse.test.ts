import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../src/sse.js';
import { streamV2EventFrames, v2LiveEventId, V2LiveEventMapper, type V2EventFrame } from '../src/v2/sse.js';

function frame(type: string, data: Record<string, unknown>): V2EventFrame {
  return { id: `evt_${type.replace(/\W/g, '_')}`, created: 1, type, data };
}

describe('V2LiveEventMapper（最小 v2 SSE 映射）', () => {
  it('文本 delta/ended：partId/revision 累计、ended 补缺、全量已到则不重复', () => {
    const mapper = new V2LiveEventMapper();
    const specs = [
      ...mapper.map(frame('session.text.delta', {
        sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 0, delta: 'Hel',
      })),
      ...mapper.map(frame('session.text.ended', {
        sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 0, text: 'Hello',
      })),
      ...mapper.map(frame('session.text.ended', {
        sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 0, text: 'Hello',
      })),
    ];
    expect(specs.map((s) => s.payload['delta'])).toEqual(['Hel', 'lo']);
    expect(specs.map((s) => s.payload['partRevision'])).toEqual([3, 5]);
    expect(specs[0]!.payload['partId']).toBe('msg_a1:0');
  });

  it('reasoning → thinking_delta', () => {
    const mapper = new V2LiveEventMapper();
    const specs = mapper.map(frame('session.reasoning.delta', {
      sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 1, delta: '嗯',
    }));
    expect(specs[0]).toMatchObject({ type: 'thinking_delta', payload: { partId: 'msg_a1:1', partRevision: 1 } });
  });

  it('工具生命周期：input started→pending、ended→running、success/failed→result', () => {
    const mapper = new V2LiveEventMapper();
    const started = mapper.map(frame('session.tool.input.started', {
      sessionID: 'ses_1', assistantMessageID: 'msg_a1', id: 'call_1', name: 'shell',
    }));
    expect(started[0]!.payload).toMatchObject({ toolCallId: 'call_1', status: 'pending', partRevision: 1 });

    const ended = mapper.map(frame('session.tool.input.ended', {
      sessionID: 'ses_1', assistantMessageID: 'msg_a1', id: 'call_1', text: '{"command":"ls"}',
    }));
    expect(ended[0]!.payload).toMatchObject({ status: 'running', input: { command: 'ls' } });

    const success = mapper.map(frame('session.tool.success', {
      sessionID: 'ses_1', assistantMessageID: 'msg_a1', id: 'call_1',
      content: [{ type: 'text', text: 'a.ts' }], executed: true,
    }));
    expect(success[0]).toMatchObject({
      type: 'tool_result',
      payload: { toolCallId: 'call_1', content: 'a.ts', isError: false, partRevision: 2 },
    });

    const failed = mapper.map(frame('session.tool.failed', {
      sessionID: 'ses_1', assistantMessageID: 'msg_a1', id: 'call_2',
      error: { type: 'Error', message: 'boom' },
      content: [{ type: 'text', text: 'partial' }], executed: true,
    }));
    expect(failed[0]!.payload).toMatchObject({ toolCallId: 'call_2', content: 'boom\npartial', isError: true });
  });

  it('执行生命周期/权限/用量映射', () => {
    const mapper = new V2LiveEventMapper();
    expect(mapper.map(frame('session.execution.started', { sessionID: 'ses_1' }))[0]).toMatchObject({
      type: 'status', payload: { status: 'running' },
    });
    expect(mapper.map(frame('session.execution.succeeded', { sessionID: 'ses_1' }))[0]).toMatchObject({
      type: 'status', payload: { status: 'idle' },
    });
    const failed = mapper.map(frame('session.execution.failed', {
      sessionID: 'ses_1', error: { type: 'Error', message: 'x' },
    }));
    expect(failed.map((s) => s.type)).toEqual(['error', 'status']);
    expect(mapper.map(frame('session.execution.interrupted', { sessionID: 'ses_1', reason: 'user' }))[0]).toMatchObject({
      type: 'status', payload: { status: 'cancelled' },
    });
    expect(mapper.map(frame('permission.asked', {
      sessionID: 'ses_1', id: 'perm_1', action: 'bash', resources: ['*'], message: 'allow?',
    }))[0]).toMatchObject({
      type: 'status',
      payload: { status: 'waiting', permissionId: 'perm_1', permission: 'bash', detail: 'allow?', patterns: ['*'] },
    });
    expect(mapper.map(frame('session.usage.updated', {
      sessionID: 'ses_1', cost: 0.5, tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    }))[0]).toMatchObject({
      type: 'usage', payload: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 },
    });
  });

  it('permission.replied 映射为 status resolved（归位审批卡，不悬挂）', () => {
    const mapper = new V2LiveEventMapper();
    const specs = mapper.map(frame('permission.replied', {
      sessionID: 'ses_1', requestID: 'perm_9', reply: { decision: 'always' },
    }));
    expect(specs[0]).toMatchObject({
      type: 'status',
      payload: { status: 'resolved', permissionId: 'perm_9', decision: 'allow_always' },
    });
  });

  it('permission.replied 未知/缺失 decision 映射为 unknown（fail-closed 不伪装）', () => {
    const mapper = new V2LiveEventMapper();
    const weird = mapper.map(frame('permission.replied', {
      sessionID: 'ses_1', requestID: 'perm_x', reply: { decision: 'weird' },
    }));
    expect(weird[0]!.payload['decision']).toBe('unknown');
    const missing = mapper.map(frame('permission.replied', {
      sessionID: 'ses_1', requestID: 'perm_y', reply: {},
    }));
    expect(missing[0]!.payload['decision']).toBe('unknown');
  });

  it('未知事件与无 sessionID 帧被忽略', () => {
    const mapper = new V2LiveEventMapper();
    expect(mapper.map(frame('session.created', { sessionID: 'ses_1' }))).toEqual([]);
    expect(mapper.map(frame('session.text.delta', { delta: 'x' }))).toEqual([]);
  });
});

describe('streamV2EventFrames', () => {
  it('连接 /api/event 并产出解析后的帧（带 Basic Auth 与 redirect 守卫）', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"evt_1","type":"session.text.delta","data":{"sessionID":"ses_1","assistantMessageID":"m","ordinal":0,"delta":"A"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"evt_2","type":"session.execution.started","data":{"sessionID":"ses_1"}}\n\n'));
        controller.close();
      },
    });
    let seenAuth: string | undefined;
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:49374/api/event');
      seenAuth = (init?.headers as Record<string, string>)['authorization'];
      expect(init?.redirect).toBe('error');
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;

    const frames: V2EventFrame[] = [];
    for await (const f of streamV2EventFrames({
      endpoint: { baseUrl: 'http://127.0.0.1:49374', password: 'pw' },
      fetch: fetchMock,
      signal: new AbortController().signal,
      parse: parseSseStream,
    })) {
      frames.push(f);
    }
    expect(frames.map((f) => f.id)).toEqual(['evt_1', 'evt_2']);
    expect(seenAuth).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`);
  });
});

describe('v2LiveEventId（P1-2 一帧多事件稳定子 ID）', () => {
  it('同一源帧的多个事件派生不同且稳定的 eventId', () => {
    const errorId = v2LiveEventId('evt_123', 'error', 0);
    const statusId = v2LiveEventId('evt_123', 'status', 1);
    expect(errorId).toBe('v2:evt_123:error:0');
    expect(statusId).toBe('v2:evt_123:status:1');
    expect(errorId).not.toBe(statusId);
    expect(v2LiveEventId('evt_123', 'error', 0)).toBe(errorId); // 重放稳定
  });

  it('seedPartLength 播种历史水位，实时 delta 的 revision 续接而非从 0 被丢弃', () => {
    const mapper = new V2LiveEventMapper();
    mapper.seedPartLength('msg_a1:0', 50);
    const specs = mapper.map(frame('session.text.delta', {
      sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 0, delta: 'ab',
    }));
    expect(specs[0]!.payload['partRevision']).toBe(52);
  });
});
