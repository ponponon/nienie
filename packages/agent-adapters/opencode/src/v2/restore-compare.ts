import { createHash } from 'node:crypto';

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
  toolCallIdA: string,
  toolCallIdB: string,
): boolean {
  if (toolCallIdA.length === 0 || toolCallIdA !== toolCallIdB) return false;
  const entry = KNOWN_TRUNCATED_OUTPUTS.find(
    (candidate) =>
      candidate.sessionId === sessionId &&
      candidate.toolCallId === toolCallIdA &&
      candidate.v1OutputSha256 === sha256Hex(v1Output) &&
      candidate.v2OutputSha256 === sha256Hex(v2Output),
  );
  return entry !== undefined;
}

export function compareItems(sessionId: string, a: CompareItem, b: CompareItem): CompareResult {
  if (a.kind !== b.kind) return 'mismatch';
  if (a.kind === 'tool' && b.kind === 'tool') {
    const headEqual =
      a.name === b.name &&
      normalizeInput(a.input) === normalizeInput(b.input) &&
      a.status === b.status &&
      a.isError === b.isError;
    if (!headEqual) return 'mismatch';
    if (a.output === b.output) return 'equal';
    return matchTruncation(sessionId, a.output, b.output, a.toolCallId, b.toolCallId) ? 'v1-truncated' : 'mismatch';
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
