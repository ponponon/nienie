import { describe, expect, it } from 'vitest';
import {
  classifyDiffFailure,
  compareItems,
  fetchV1DiffFiles,
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

describe('J0.6b-3.4 Final Seal 覆盖', () => {
  it('toolCallId 不同但 output 相同也必须 mismatch（equal 路径身份校验）', () => {
    expect(
      compareItems('ses_any', tool({ toolCallId: 'call_A', output: 'hello' }), tool({ toolCallId: 'call_B', output: 'hello' })),
    ).toBe('mismatch');
    expect(compareItems('ses_any', tool({ toolCallId: '', output: 'hello' }), tool({ toolCallId: '', output: 'hello' }))).toBe('mismatch');
  });

  it('真实白名单正向命中：可注入白名单 + 双哈希精确匹配 → v1-truncated', () => {
    const v1Output = 'v1-truncated-output';
    const v2Output = 'v2-full-output-complete';
    const allowlist = [
      {
        sessionId: 'ses_test',
        toolCallId: 'call_test',
        v1OutputSha256: sha256Hex(v1Output),
        v2OutputSha256: sha256Hex(v2Output),
      },
    ];
    expect(
      compareItems('ses_test', tool({ toolCallId: 'call_test', output: v1Output }), tool({ toolCallId: 'call_test', output: v2Output }), allowlist),
    ).toBe('v1-truncated');
    // v2 输出变了 → 白名单不命中
    expect(
      compareItems('ses_test', tool({ toolCallId: 'call_test', output: v1Output }), tool({ toolCallId: 'call_test', output: 'other' }), allowlist),
    ).toBe('mismatch');
  });

  it('v1 Diff API 非 2xx / 网络错误 / 非数组响应一律抛错（不吞成空数组）', async () => {
    const fail500 = (async () => new Response('boom', { status: 500 })) as typeof globalThis.fetch;
    await expect(fetchV1DiffFiles('http://127.0.0.1:4096', 'ses_1', fail500)).rejects.toThrow(/v1 Diff API failed: 500/);

    const netFail = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    await expect(fetchV1DiffFiles('http://127.0.0.1:4096', 'ses_1', netFail)).rejects.toThrow(/ECONNREFUSED/);

    const badBody = (async () => new Response('{"not":"array"}', { status: 200 })) as typeof globalThis.fetch;
    await expect(fetchV1DiffFiles('http://127.0.0.1:4096', 'ses_1', badBody)).rejects.toThrow(/expected an array/);

    const ok = (async () => new Response('[{"file":"a.ts"}]', { status: 200 })) as typeof globalThis.fetch;
    await expect(fetchV1DiffFiles('http://127.0.0.1:4096', 'ses_1', ok)).resolves.toEqual(['a.ts']);
  });

  it('失败分类：v2 白名单豁免仅限 v2；v1 失败/网络错误一律 fatal', () => {
    expect(classifyDiffFailure('ses_f2ea6263cffeV3IV9R1s9PF4BM', 'v2')).toBe('whitelisted-unverified');
    expect(classifyDiffFailure('ses_unknown', 'v2')).toBe('fatal');
    expect(classifyDiffFailure('ses_f2ea6263cffeV3IV9R1s9PF4BM', 'v1')).toBe('fatal');
    expect(classifyDiffFailure('ses_unknown', 'v1')).toBe('fatal');
  });
});
