import { describe, expect, it } from 'vitest';
import {
  classifyDiffFailure,
  compareItems,
  fetchV1DiffFiles,
  isDiff500Whitelisted,
  normalizeInput,
  sha256Hex,
  verifySessionDiffs,
  type CompareItem,
} from '../src/v2/restore-compare.js';
import { OpenCodeV2ClientError } from '../src/v2/client.js';
import type { OpenCodeV2SessionMessageInfo } from '../src/v2/types.js';

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

  it('失败分类最小授权：仅 v2+真实 HTTP 500+白名单豁免，其余 fatal', () => {
    const white = 'ses_f2ea6263cffeV3IV9R1s9PF4BM';
    expect(classifyDiffFailure(white, 'v2', new OpenCodeV2ClientError('x', 500))).toBe('whitelisted-unverified');
    expect(classifyDiffFailure(white, 'v2', new OpenCodeV2ClientError('net', 0))).toBe('fatal');
    expect(classifyDiffFailure(white, 'v2', new OpenCodeV2ClientError('nf', 404))).toBe('fatal');
    expect(classifyDiffFailure(white, 'v2', new OpenCodeV2ClientError('auth', 401))).toBe('fatal');
    expect(classifyDiffFailure('ses_unknown', 'v2', new OpenCodeV2ClientError('x', 500))).toBe('fatal');
    expect(classifyDiffFailure(white, 'v1', new OpenCodeV2ClientError('x', 500))).toBe('fatal');
    // 普通异常（非 API 错误）绝不当 HTTP 500 豁免
    expect(classifyDiffFailure(white, 'v2', new Error('local boom'))).toBe('fatal');
    expect(classifyDiffFailure(white, 'v2', undefined)).toBe('fatal');
  });
});

describe('verifySessionDiffs（J0.6b-3.5 验收表七行）', () => {
  const messages: OpenCodeV2SessionMessageInfo[] = [
    { id: 'msg_u1', time: { created: 1 }, type: 'user', text: 'hi' },
    {
      id: 'msg_a1',
      time: { created: 2 },
      type: 'assistant',
      agent: 'build',
      model: { id: 'm', providerID: 'p' },
      content: [{ type: 'tool', id: 'call_1', name: 'edit', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'ok' }] }, time: { created: 2 } }],
    },
  ];
  const white = 'ses_f2ea6263cffeV3IV9R1s9PF4BM';
  const diff = { file: 'a.ts', patch: '@@', additions: 1, deletions: 0, status: 'modified' as const };
  const okFetch = (async () => new Response('[{"file":"a.ts"}]', { status: 200 })) as typeof globalThis.fetch;

  const clientThrowing = (error: unknown) => ({
    getSessionDiff: async () => {
      throw error;
    },
  });
  const clientOk = () => ({
    getSessionDiff: async () => [diff],
  });

  it('v2 + 白名单 + HTTP 500 → unverified', async () => {
    const out = await verifySessionDiffs({
      sessionId: white, messages, client: clientThrowing(new OpenCodeV2ClientError('x', 500)), v1Base: 'http://127.0.0.1:4096', doFetch: okFetch,
    });
    expect(out.status).toBe('unverified');
  });

  it('v2 + 白名单 + 网络错误/404/401 → fatal', async () => {
    for (const error of [new OpenCodeV2ClientError('net', 0), new OpenCodeV2ClientError('nf', 404), new OpenCodeV2ClientError('auth', 401)]) {
      const out = await verifySessionDiffs({
        sessionId: white, messages, client: clientThrowing(error), v1Base: 'http://127.0.0.1:4096', doFetch: okFetch,
      });
      expect(out.status).toBe('fatal');
    }
  });

  it('v2 + 非白名单 + HTTP 500 → fatal', async () => {
    const out = await verifySessionDiffs({
      sessionId: 'ses_unknown', messages, client: clientThrowing(new OpenCodeV2ClientError('x', 500)), v1Base: 'http://127.0.0.1:4096', doFetch: okFetch,
    });
    expect(out.status).toBe('fatal');
  });

  it('v1 任意错误 → fatal（不吃 v2 白名单）', async () => {
    const failFetch = (async () => new Response('boom', { status: 500 })) as typeof globalThis.fetch;
    const out = await verifySessionDiffs({
      sessionId: white, messages, client: clientOk(), v1Base: 'http://127.0.0.1:4096', doFetch: failFetch,
    });
    expect(out.status).toBe('fatal');
  });

  it('本地 resolveDiffTurnRange 异常 → fatal', async () => {
    const out = await verifySessionDiffs({
      sessionId: white,
      messages: [{ id: 'msg_a1', time: { created: 1 }, type: 'assistant', agent: 'a', model: { id: 'm', providerID: 'p' }, content: [] }],
      client: clientOk(),
      v1Base: 'http://127.0.0.1:4096',
      doFetch: okFetch,
    });
    expect(out.status).toBe('fatal');
  });

  it('全部一致时 ok', async () => {
    const out = await verifySessionDiffs({
      sessionId: 'ses_any', messages, client: clientOk(), v1Base: 'http://127.0.0.1:4096', doFetch: okFetch,
    });
    expect(out.status).toBe('ok');
  });
});
