import { createHash } from 'node:crypto';
import { OpenCodeV2ClientError } from './client.js';
import { resolveDiffTurnRange } from './message-restore.js';
import { deriveDiffId } from './diff-id.js';
import type { OpenCodeV2FileDiffInfo, OpenCodeV2SessionMessageInfo } from './types.js';

export type CompareItem =
  | { kind: 'user_text' | 'assistant_text'; text: string; synthetic?: boolean }
  | { kind: 'attachment'; name: string; mime: string; uri?: string; contentHash?: string }
  | { kind: 'tool'; name: string; input: string; output: string; status: string; isError: boolean; toolCallId: string };

export type CompareResult = 'equal' | 'v1-truncated' | 'mismatch';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 工具 input 的规范化 JSON（键排序）：消除序列化键序差异。 */
export function normalizeInput(raw: string): string {
  try {
    return stableStringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type KnownTruncationEntry = {
  sessionId: string;
  toolCallId: string;
  v1OutputSha256: string;
  v2OutputSha256: string;
};

/** 截断豁免白名单（J0.6b-3.3）：只允许逐项人工核实过的 v1 Tool Output。
 *  校验四点全等：sessionId、toolCallId 双边相等、v1 输出 SHA-256、v2 输出 SHA-256。
 *  不允许任何通用前缀/包含规则。 */
export const KNOWN_TRUNCATED_OUTPUTS: KnownTruncationEntry[] = [
  {
    sessionId: 'ses_f2ea6da23ffeUSIts4GRmp419x',
    toolCallId: 'call_5e0b2bb6a43d438d88db5149',
    v1OutputSha256: '850f6a4bf09e5210ebed264b73d293da603fb9468eebc017880e0a8a62811394',
    v2OutputSha256: '09092dde8c07235250dcc14ceddda403e91f8766ab62c2586ebfc8a1f1fcdee3',
  },
  {
    sessionId: 'ses_f2ea6da23ffeUSIts4GRmp419x',
    toolCallId: 'call_e493bf9aeca14fd6a43208b4',
    v1OutputSha256: '69075009c724845d920f648b79fb0b41f8ba0462feba05b1d107ba8188408991',
    v2OutputSha256: '98edeaa6c537c58c026865e26709a8c5f43c96bd1e93d7320bfe8294ce50c5e6',
  },
];

/** 旧迁移数据（悬空 assistant.snapshot 引用）导致 v2 Diff API 500 的已核实会话白名单。
 *  白名单外的 Diff API 失败必须导致对照脚本非零退出。 */
export const KNOWN_DIFF_500_SESSIONS = new Set<string>([
  'ses_f2ea4921fffe2uThhpkN9PNTDd',
  'ses_f2ea6263cffeV3IV9R1s9PF4BM',
  'ses_f2ea58494ffezxgx1B97Ybotmu',
  'ses_f2ea67228ffelz6aMLEgQwlnQp',
  'ses_f2ea7da99ffekj2MhgDfodZpQc',
  'ses_f2ea6da23ffeUSIts4GRmp419x',
  'ses_f2ea7da95ffeavoq0x8sOcMtpQ',
  'ses_f2ea7daa1ffesNgcWvFTqIx9ll',
  'ses_ed50d7ed7ffeEvECC8XmRsMcLJ',
  'ses_f9b03a757ffeton52hz8QA1Jk7',
  'ses_fa5677e67ffe8xoLxqQxIWTphI',
]);

export function isDiff500Whitelisted(sessionId: string): boolean {
  return KNOWN_DIFF_500_SESSIONS.has(sessionId);
}

function matchTruncation(
  sessionId: string,
  v1Output: string,
  v2Output: string,
  toolCallId: string,
  allowlist: KnownTruncationEntry[],
): boolean {
  const entry = allowlist.find(
    (candidate) =>
      candidate.sessionId === sessionId &&
      candidate.toolCallId === toolCallId &&
      candidate.v1OutputSha256 === sha256Hex(v1Output) &&
      candidate.v2OutputSha256 === sha256Hex(v2Output),
  );
  return entry !== undefined;
}

export function compareItems(
  sessionId: string,
  a: CompareItem,
  b: CompareItem,
  allowlist: KnownTruncationEntry[] = KNOWN_TRUNCATED_OUTPUTS,
): CompareResult {
  if (a.kind !== b.kind) return 'mismatch';
  if (a.kind === 'tool' && b.kind === 'tool') {
    const headEqual =
      a.toolCallId.length > 0 &&
      a.toolCallId === b.toolCallId &&
      a.name === b.name &&
      normalizeInput(a.input) === normalizeInput(b.input) &&
      a.status === b.status &&
      a.isError === b.isError;
    if (!headEqual) return 'mismatch';
    if (a.output === b.output) return 'equal';
    return matchTruncation(sessionId, a.output, b.output, a.toolCallId, allowlist) ? 'v1-truncated' : 'mismatch';
  }
  if (a.kind === 'attachment' && b.kind === 'attachment') {
    if (a.name !== b.name || a.mime !== b.mime) return 'mismatch';
    if (a.uri !== undefined && b.uri !== undefined) return a.uri === b.uri ? 'equal' : 'mismatch';
    if (a.contentHash !== undefined && b.contentHash !== undefined) {
      return a.contentHash === b.contentHash ? 'equal' : 'mismatch';
    }
    return 'mismatch';
  }
  return (a as { text: string }).text === (b as { text: string }).text ? 'equal' : 'mismatch';
}

export type DiffFailureSide = 'v1' | 'v2';

/** Diff 失败分类（J0.6b-3.5 最小授权）：仅「v2 侧 + 真实 HTTP 500（OpenCodeV2ClientError.status===500）+ 白名单会话」可豁免；
 *  网络错误（status 0）、401/404/429、普通异常、v1 侧任何失败一律 fatal。status 从错误对象提取，不接受调用方随意传入。 */
export function classifyDiffFailure(
  sessionId: string,
  side: DiffFailureSide,
  error: unknown,
): 'whitelisted-unverified' | 'fatal' {
  if (
    side === 'v2' &&
    error instanceof OpenCodeV2ClientError &&
    error.status === 500 &&
    isDiff500Whitelisted(sessionId)
  ) {
    return 'whitelisted-unverified';
  }
  return 'fatal';
}

export type DiffVerifyOutcome =
  | { status: 'ok'; deterministic: boolean; unique: boolean; filesEqual: boolean; v1Files: number; v2Files: number }
  | { status: 'unverified'; reason: string }
  | { status: 'fatal'; reason: string };

/** 会话 Diff 一致性验证：白名单豁免只作用于 client.getSessionDiff 的 HTTP 500；
 *  本地 resolveDiffTurnRange / diffId 计算 / v1 API / 其余错误一律 fatal（fail-closed）。 */
export async function verifySessionDiffs(options: {
  sessionId: string;
  messages: OpenCodeV2SessionMessageInfo[];
  client: {
    getSessionDiff(
      sessionId: string,
      query?: { from?: string | undefined; to?: string | undefined; context?: string | undefined },
    ): Promise<OpenCodeV2FileDiffInfo[]>;
  };
  v1Base: string;
  doFetch: typeof globalThis.fetch;
}): Promise<DiffVerifyOutcome> {
  let range: { fromMessageId: string; toMessageId: string };
  try {
    range = resolveDiffTurnRange(options.messages);
  } catch (error) {
    return { status: 'fatal', reason: `本地 diff 范围解析失败: ${String(error)}` };
  }
  let first: OpenCodeV2FileDiffInfo[];
  let second: OpenCodeV2FileDiffInfo[];
  try {
    const query = { from: range.fromMessageId, to: range.toMessageId };
    first = await options.client.getSessionDiff(options.sessionId, query);
    second = await options.client.getSessionDiff(options.sessionId, query);
  } catch (error) {
    return classifyDiffFailure(options.sessionId, 'v2', error) === 'whitelisted-unverified'
      ? { status: 'unverified', reason: `旧迁移白名单（已核实上游 500）` }
      : { status: 'fatal', reason: `v2 Diff API 失败: ${String(error)}` };
  }
  let deterministic: boolean;
  let unique: boolean;
  try {
    const idsOf = (list: OpenCodeV2FileDiffInfo[]) =>
      list.map((d) =>
        deriveDiffId({
          sessionId: options.sessionId,
          fromMessageId: range.fromMessageId,
          toMessageId: range.toMessageId,
          file: d.file,
          patch: d.patch,
        }),
      );
    deterministic = JSON.stringify(idsOf(first)) === JSON.stringify(idsOf(second));
    unique = new Set(idsOf(first)).size === first.length;
  } catch (error) {
    return { status: 'fatal', reason: `diffId 计算失败: ${String(error)}` };
  }
  let v1Files: string[];
  try {
    v1Files = await fetchV1DiffFiles(options.v1Base, options.sessionId, options.doFetch);
  } catch (error) {
    return { status: 'fatal', reason: `v1 Diff API 失败（fail-closed）: ${String(error)}` };
  }
  const v2Files = first.map((d) => d.file).sort();
  const filesEqual = JSON.stringify(v1Files) === JSON.stringify(v2Files);
  if (!deterministic) return { status: 'fatal', reason: 'diffId 跨请求不稳定' };
  if (!unique) return { status: 'fatal', reason: 'diffId 单响应重复' };
  if (!filesEqual) return { status: 'fatal', reason: 'v1/v2 diff 文件集合不一致' };
  return { status: 'ok', deterministic, unique, filesEqual, v1Files: v1Files.length, v2Files: v2Files.length };
}

/** 读取 v1 Diff API 的文件集合：非 2xx / 网络错误 / 非数组响应一律抛错（不得吞成空数组）。 */
export async function fetchV1DiffFiles(
  baseUrl: string,
  sessionId: string,
  doFetch: typeof globalThis.fetch,
): Promise<string[]> {
  const response = await doFetch(`${baseUrl.replace(/\/+$/, '')}/session/${encodeURIComponent(sessionId)}/diff`);
  if (!response.ok) {
    throw new Error(`v1 Diff API failed: ${response.status}`);
  }
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('Invalid v1 Diff response: expected an array');
  }
  return data.map((d) => String((d as Record<string, unknown>)['file'] ?? '')).sort();
}
