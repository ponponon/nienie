import { describe, expect, it } from 'vitest';
import {
  buildSnapshotParts,
  extractToolOutput,
  mapV2ToolStatus,
  resolveDiffTurnRange,
  restoreHistoryEvents,
  type RestoredEventSpec,
} from '../src/v2/message-restore.js';
import type {
  OpenCodeV2AssistantMessage,
  OpenCodeV2SessionMessageInfo,
  OpenCodeV2ToolState,
  OpenCodeV2UserMessage,
} from '../src/v2/types.js';

const userMsg: OpenCodeV2UserMessage = {
  id: 'msg_u1',
  time: { created: 1760000000000 },
  type: 'user',
  text: '帮我分析',
};

const assistantMsg: OpenCodeV2AssistantMessage = {
  id: 'msg_a1',
  time: { created: 1760000001000 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'claude-sonnet-4', providerID: 'anthropic' },
  content: [
    { type: 'text', text: '好的' },
    { type: 'reasoning', text: '先看看结构' },
    {
      type: 'tool',
      id: 'call_1',
      name: 'shell',
      state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'a.ts' }] },
      time: { created: 1760000001100 },
    },
  ],
};

function toolState(state: OpenCodeV2ToolState): OpenCodeV2AssistantMessage {
  return {
    id: 'msg_t',
    time: { created: 1760000002000 },
    type: 'assistant',
    agent: 'build',
    model: { id: 'claude-sonnet-4', providerID: 'anthropic' },
    content: [{ type: 'tool', id: 'call_x', name: 'shell', state, time: { created: 1760000002000 } }],
  };
}

describe('mapV2ToolStatus / extractToolOutput', () => {
  it('maps the four v2 tool states to Nienie statuses', () => {
    expect(mapV2ToolStatus('streaming')).toBe('pending');
    expect(mapV2ToolStatus('running')).toBe('running');
    expect(mapV2ToolStatus('completed')).toBe('completed');
    expect(mapV2ToolStatus('error')).toBe('failed');
  });

  it('extracts input/output per state (error message wins, file blocks are marked)', () => {
    expect(extractToolOutput({ status: 'streaming', input: '{"command":"ls"' })).toEqual({
      input: {},
      output: '',
      isError: false,
    });
    expect(extractToolOutput({ status: 'streaming', input: '{"command":"ls"}' }).input).toEqual({'command': 'ls'});
    expect(extractToolOutput({ status: 'running', input: { command: 'ls' }, metadata: {} })).toEqual({
      input: {'command': 'ls'},
      output: '',
      isError: false,
    });
    expect(
      extractToolOutput({
        status: 'completed',
        input: {},
        content: [{ type: 'text', text: 'out' }, { type: 'file', uri: 'file:///x', mime: 'text/plain', name: 'x.txt' }],
      }),
    ).toEqual({ input: {}, output: 'out\nfile:x.txt|file:///x', isError: false });
    expect(
      extractToolOutput({
        status: 'error',
        input: {},
        error: { type: 'Error', message: 'boom' },
        content: [{ type: 'text', text: 'partial' }],
      }),
    ).toEqual({ input: {}, output: 'boom\npartial', isError: true });
  });
});

describe('restoreHistoryEvents', () => {
  it('emits ordered specs with stable partId/revision/messageId', () => {
    const events = restoreHistoryEvents([userMsg, assistantMsg]);
    expect(events.map((e: RestoredEventSpec) => e.type)).toEqual([
      'text_delta',
      'text_delta',
      'thinking_delta',
      'tool_use',
      'tool_result',
    ]);
    expect(events[0]!.payload).toEqual({
      delta: '帮我分析',
      role: 'user',
      partId: 'msg_u1:0',
      partRevision: 4,
      messageId: 'msg_u1',
      attachments: [],
    });
    expect(events[1]!.payload).toMatchObject({ partId: 'msg_a1:0', partRevision: 2, messageId: 'msg_a1' });
    expect(events[2]!.payload).toMatchObject({ partId: 'msg_a1:1', partRevision: 5 });
    expect(events[3]!.payload).toMatchObject({
      toolCallId: 'call_1',
      name: 'shell',
      input: {'command': 'ls'},
      partId: 'call_1',
      partRevision: 1,
    });
    expect(events[4]!.payload).toMatchObject({
      toolCallId: 'call_1',
      content: 'a.ts',
      isError: false,
      partRevision: 2,
    });
  });

  it('emits tool_use only for non-terminal tool states', () => {
    for (const state of [
      { status: 'streaming', input: '{}' },
      { status: 'running', input: {}, metadata: {} },
    ] as OpenCodeV2ToolState[]) {
      const events = restoreHistoryEvents([toolState(state)]);
      expect(events.map((e) => e.type)).toEqual(['tool_use']);
    }
    for (const state of [
      { status: 'completed', input: {}, content: [{ type: 'text', text: 'ok' }] },
      { status: 'error', input: {}, error: { type: 'Error', message: 'bad' } },
    ] as OpenCodeV2ToolState[]) {
      const events = restoreHistoryEvents([toolState(state)]);
      expect(events.map((e) => e.type)).toEqual(['tool_use', 'tool_result']);
      expect(events[1]!.payload['isError']).toBe(state.status === 'error');
    }
  });
});

describe('buildSnapshotParts', () => {
  it('builds ordered parts with explicit tool status and revisions', () => {
    const parts = buildSnapshotParts([userMsg, assistantMsg]);
    expect(parts.map((p) => p.kind)).toEqual(['message', 'message', 'thinking', 'tool_call']);
    expect(parts.map((p) => p.ordinal)).toEqual([0, 1, 2, 3]);
    expect(parts[0]).toMatchObject({ role: 'user', partId: 'msg_u1:0', revision: 4 });
    expect(parts[3]).toMatchObject({
      toolCallId: 'call_1',
      name: 'shell',
      status: 'completed',
      output: 'a.ts',
      isError: false,
      partId: 'call_1',
      revision: 2,
    });
  });

  it('restores non-terminal tools as running with revision 1', () => {
    const parts = buildSnapshotParts([toolState({ status: 'running', input: { command: 'ls' }, metadata: {} })]);
    expect(parts[0]).toMatchObject({ status: 'running', revision: 1 });
  });
});

describe('resolveDiffTurnRange', () => {
  const u2: OpenCodeV2UserMessage = {
    id: 'msg_u2',
    time: { created: 1760000003000 },
    type: 'user',
    text: '再来一个',
  };

  it('defaults to the newest user message turn alone', () => {
    expect(resolveDiffTurnRange([userMsg, assistantMsg, u2])).toEqual({
      fromMessageId: 'msg_u2',
      toMessageId: 'msg_u2',
    });
  });

  it('resolves explicit ranges and validates turn order', () => {
    expect(resolveDiffTurnRange([userMsg, assistantMsg, u2], 'msg_u1', 'msg_u2')).toEqual({
      fromMessageId: 'msg_u1',
      toMessageId: 'msg_u2',
    });
    expect(resolveDiffTurnRange([userMsg, assistantMsg, u2], 'msg_u2')).toEqual({
      fromMessageId: 'msg_u2',
      toMessageId: 'msg_u2',
    });
    expect(() => resolveDiffTurnRange([userMsg, assistantMsg, u2], 'msg_u2', 'msg_u1')).toThrow();
    expect(() => resolveDiffTurnRange([userMsg, assistantMsg, u2], 'msg_missing')).toThrow();
    expect(() => resolveDiffTurnRange([assistantMsg])).toThrow();
    expect(() => resolveDiffTurnRange([userMsg, assistantMsg, u2], 'msg_a1')).toThrow();
  });
});

describe('J0.6b-3a 保真策略', () => {
  it('tool_use 携带显式 status（streaming→pending），tool_result 仍为终态事件', () => {
    const events = restoreHistoryEvents([toolState({ status: 'streaming', input: '{"command":"ls"' })]);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['status']).toBe('pending');
    const done = restoreHistoryEvents([toolState({ status: 'completed', input: {}, content: [{ type: 'text', text: 'ok' }] })]);
    expect(done[0]!.payload['status']).toBe('completed');
  });

  it('空文本但带附件的用户消息不消失：保留 name/uri/mime', () => {
    const attachmentOnly: OpenCodeV2UserMessage = {
      id: 'msg_file',
      time: { created: 1760000000000 },
      type: 'user',
      text: '',
      files: [{ data: 'AA==', mime: 'text/plain', source: { type: 'uri', uri: 'file:///w/a.ts' }, name: 'a.ts' }],
      agents: [{ name: 'explore' }],
      skills: [{ id: 'skill_1', name: 's1' }],
    };
    const events = restoreHistoryEvents([attachmentOnly]);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['delta']).toBe('file:a.ts|file:///w/a.ts|text/plain\nagent:explore\nskill:skill_1');
    const parts = buildSnapshotParts([attachmentOnly]);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.kind).toBe('message');
    expect((parts[0] as unknown as { content: Array<{ text: string }> }).content[0]!.text).toContain('file:a.ts|file:///w/a.ts|text/plain');
  });

  it('error 工具保留部分输出与错误信息两者', () => {
    const events = restoreHistoryEvents([
      toolState({
        status: 'error',
        input: {},
        error: { type: 'Error', message: 'boom' },
        content: [{ type: 'text', text: 'partial' }],
      }),
    ]);
    expect(events[1]!.payload['content']).toBe('boom\npartial');
  });

  it('拒绝降序消息数组（防止分页拼接错误导致顺序错乱）', () => {
    const descending = [
      { ...userMsg, id: 'msg_late', time: { created: 3000 } },
      { ...userMsg, id: 'msg_early', time: { created: 1000 } },
    ] as OpenCodeV2SessionMessageInfo[];
    expect(() => restoreHistoryEvents(descending)).toThrow(/ascending/);
    expect(() => buildSnapshotParts(descending)).toThrow(/ascending/);
    expect(() => resolveDiffTurnRange(descending)).toThrow(/ascending/);
  });
});

describe('附件结构化保留（J0.6b-3.1）', () => {
  const withTextAndFile: OpenCodeV2UserMessage = {
    id: 'msg_att',
    time: { created: 1760000000000 },
    type: 'user',
    text: '请分析这个图片',
    files: [
      { data: 'AA==', mime: 'image/png', source: { type: 'uri', uri: 'file:///w/image.png' }, name: 'image.png' },
      { data: 'SGVsbG8=', mime: 'text/plain', source: { type: 'inline' }, name: 'note.txt' },
    ],
  };

  it('文本与附件并存时附件不再丢失（payload.attachments 结构化）', () => {
    const events = restoreHistoryEvents([withTextAndFile]);
    expect(events).toHaveLength(1);
    const attachments = events[0]!.payload['attachments'] as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({ name: 'image.png', mime: 'image/png', sourceType: 'uri', uri: 'file:///w/image.png' });
    expect(attachments[1]!.sourceType).toBe('inline');
    expect(attachments[1]!.contentHash).toMatch(/^[0-9a-f]{64}$/); // inline 数据保留 SHA-256 摘要
    expect(events[0]!.payload['delta']).toBe('请分析这个图片');
  });

  it('快照 message part 以 resource 块保留附件元数据', () => {
    const parts = buildSnapshotParts([withTextAndFile]);
    const content = (parts[0] as unknown as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toMatchObject({ type: 'text', text: '请分析这个图片' });
    expect(content[1]).toMatchObject({ type: 'resource', uri: 'file:///w/image.png', mimeType: 'image/png' });
    expect(String(content[2]!['uri'])).toMatch(/^inline:[0-9a-f]{64}$/);
  });
});

describe('J0.6b-3.3 显式 synthetic 标记', () => {
  it('普通用户消息即使以 file: 开头也不标记 syntheticSummary', () => {
    const events = restoreHistoryEvents([
      { id: 'msg_f', time: { created: 1 }, type: 'user', text: 'file:hello 不是摘要' },
    ]);
    expect(events[0]!.payload['syntheticSummary']).toBeUndefined();
    expect(events[0]!.payload['delta']).toBe('file:hello 不是摘要');
  });

  it('空文本附件消息的合成摘要显式标记 syntheticSummary', () => {
    const events = restoreHistoryEvents([
      {
        id: 'msg_s',
        time: { created: 1 },
        type: 'user',
        text: '',
        files: [{ data: 'AA==', mime: 'text/plain', source: { type: 'uri', uri: 'file:///w/a.txt' }, name: 'a.txt' }],
      },
    ]);
    expect(events[0]!.payload['syntheticSummary']).toBe(true);
    expect(String(events[0]!.payload['delta'])).toContain('file:a.txt|');
  });
});

describe('buildSnapshotParts tool time', () => {
  it('Round 3：startedAt 只认 ran、finishedAt 只认 completed（不沿用 Message/created 时间）', () => {
    const created = 1760000001100;
    const ran = 1760000002100;
    const completed = 1760000006100;
    const msg: OpenCodeV2AssistantMessage = {
      id: 'msg_t2',
      time: { created: 1760000000000 }, // Message 时间刻意不同
      type: 'assistant',
      agent: 'build',
      model: { id: 'm', providerID: 'p' },
      content: [
        {
          type: 'tool',
          id: 'call_t',
          name: 'shell',
          state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'ok' }] },
          time: { created, ran, completed },
        },
      ],
    };
    const parts = buildSnapshotParts([msg]);
    const tool = parts.find((p) => p.kind === 'tool_call');
    expect(tool).toBeDefined();
    expect(tool!.toolStartedAt).toBe(new Date(ran).toISOString()); // 不是 created
    expect(tool!.toolFinishedAt).toBe(new Date(completed).toISOString());
  });

  it('Round 3：terminal + ran 存在 + completed 缺失 → 不伪造耗时（toolFinishedAt 缺失）', () => {
    const parts = buildSnapshotParts([
      {
        id: 'msg_t5',
        time: { created: 1 },
        type: 'assistant',
        agent: 'a',
        model: { id: 'm', providerID: 'p' },
        content: [
          {
            type: 'tool',
            id: 'call_t5',
            name: 'shell',
            state: {
              status: 'completed',
              input: { command: 'ls' },
              content: [{ type: 'text', text: 'ok' }],
            } as unknown as OpenCodeV2ToolState,
            time: { created: 1760000001000, ran: 1760000002000 }, // completed 缺失
          },
        ],
      },
    ]);
    const tool = parts.find((p) => p.kind === 'tool_call');
    expect(tool!.toolStartedAt).toBe(new Date(1760000002000).toISOString());
    expect(tool!.toolFinishedAt).toBeUndefined(); // 宁可无耗时，不显示语义错误的耗时
  });

  it('Round 3：ran 缺失 → toolStartedAt 缺失（不假装知道开始时间）', () => {
    const parts = buildSnapshotParts([
      {
        id: 'msg_t6',
        time: { created: 1 },
        type: 'assistant',
        agent: 'a',
        model: { id: 'm', providerID: 'p' },
        content: [
          {
            type: 'tool',
            id: 'call_t6',
            name: 'shell',
            state: { status: 'running', input: { command: 'ls' } } as unknown as OpenCodeV2ToolState,
            time: { created: 1760000001000 },
          },
        ],
      },
    ]);
    const tool = parts.find((p) => p.kind === 'tool_call')!;
    expect(tool.toolStartedAt).toBeUndefined();
    expect(tool.toolFinishedAt).toBeUndefined();
  });
});
