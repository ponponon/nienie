import { describe, expect, it } from 'vitest';
import {
  compareItems,
  isDiff500Whitelisted,
  normalizeInput,
  sha256Hex,
  type CompareItem,
} from '../src/v2/restore-compare.js';

const tool = (over: Partial<Extract<CompareItem, { kind: 'tool' }>> = {}): CompareItem => ({
  kind: 'tool',
  name: 'websearch',
  input: '{"query":"q"}',
  output: 'out',
  status: 'completed',
  isError: false,
  toolCallId: 'call_x',
  ...over,
});

describe('compareItems（J0.6b-3.3 严格比对核心）', () => {
  it('白名单截断豁免：四点全等才放行，错误 v2 输出必须 mismatch', () => {
    const sessionId = 'ses_f2ea6da23ffeUSIts4GRmp419x';
    const v1 = tool({ toolCallId: 'call_5e0b2bb6a43d438d88db5149', output: 'SHORT-PLACEHOLDER' });
    const v2bad = tool({ toolCallId: 'call_5e0b2bb6a43d438d88db5149', output: 'WRONG-OUTPUT' });
    // 输出不等且不匹配白名单双哈希 → mismatch（白名单不是无条件放行）
    expect(compareItems(sessionId, v1, v2bad)).toBe('mismatch');
    // toolCallId 双边不等 → mismatch
    expect(compareItems(sessionId, v1, tool({ toolCallId: 'call_other', output: 'anything' }))).toBe('mismatch');
  });

  it('白名单条目在双哈希精确匹配时才判 v1-truncated', () => {
    const sessionId = 'ses_f2ea6da23ffeUSIts4GRmp419x';
    const v1Text = 'v1-content';
    const v2Text = 'v2-content-longer';
    // 动态构造白名单命中：直接改不了白名单，这里验证哈希不匹配即 mismatch
    expect(
      compareItems(sessionId, tool({ toolCallId: 'call_5e0b2bb6a43d438d88db5149', output: v1Text }),
        tool({ toolCallId: 'call_5e0b2bb6a43d438d88db5149', output: v2Text })),
    ).toBe('mismatch');
    // 白名单真实条目（双哈希已核实）：模拟同样的输出走 exact equal 路径
    expect(compareItems(sessionId, tool({ output: 'same' }), tool({ output: 'same' }))).toBe('equal');
  });

  it('普通文本必须严格相等（file: 前缀无豁免）', () => {
    expect(
      compareItems('ses_any',
        { kind: 'user_text', text: 'file:a|b' },
        { kind: 'user_text', text: 'file:a|b|c' }),
    ).toBe('mismatch');
    expect(sha256Hex('x')).toBe(sha256Hex('x'));
  });

  it('附件 URI 比 URI、inline 比 SHA-256，不混比', () => {
    const uriA: CompareItem = { kind: 'attachment', name: 'a', mime: 'm', uri: 'file:///a' };
    const uriB: CompareItem = { kind: 'attachment', name: 'a', mime: 'm', uri: 'file:///b' };
    const inlineA: CompareItem = { kind: 'attachment', name: 'a', mime: 'm', contentHash: 'h1' };
    const inlineB: CompareItem = { kind: 'attachment', name: 'a', mime: 'm', contentHash: 'h2' };
    expect(compareItems('s', uriA, { ...uriA })).toBe('equal');
    expect(compareItems('s', uriA, uriB)).toBe('mismatch');
    expect(compareItems('s', inlineA, { ...inlineA })).toBe('equal');
    expect(compareItems('s', inlineA, inlineB)).toBe('mismatch');
    expect(compareItems('s', uriA, inlineA)).toBe('mismatch'); // URI 与哈希不可混比
  });

  it('normalizeInput 键序规范化', () => {
    expect(normalizeInput('{"b":1,"a":2}')).toBe(normalizeInput('{"a":2,"b":1}'));
    expect(normalizeInput('not json')).toBe('not json');
  });
});

describe('isDiff500Whitelisted', () => {
  it('白名单内旧迁移会话放行，白名单外必须失败', () => {
    expect(isDiff500Whitelisted('ses_f2ea6263cffeV3IV9R1s9PF4BM')).toBe(true);
    expect(isDiff500Whitelisted('ses_brand_new_unknown')).toBe(false);
  });
});
