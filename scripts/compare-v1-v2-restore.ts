import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverOpenCodeService } from '../packages/agent-adapters/opencode/src/service-discovery.ts';
import { OpenCodeV2Client } from '../packages/agent-adapters/opencode/src/v2/client.ts';
import { resolveDiffTurnRange, restoreHistoryEvents } from '../packages/agent-adapters/opencode/src/v2/message-restore.ts';
import { deriveDiffId } from '../packages/agent-adapters/opencode/src/v2/diff-id.ts';
import {
  compareItems,
  verifySessionDiffs,
  type CompareItem,
} from '../packages/agent-adapters/opencode/src/v2/restore-compare.ts';

type Item = CompareItem;

const dbPath = join(homedir(), '.local/share/opencode/opencode.db');
if (!existsSync(dbPath)) {
  console.error('opencode.db not found');
  process.exit(2);
}

function sql(query: string): Array<Record<string, unknown>> {
  const out = execFileSync('sqlite3', ['-json', dbPath, query], {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out || '[]') as Array<Record<string, unknown>>;
}

function v1Items(sessionId: string): Item[] {
  const rows = sql(
    `SELECT json_extract(p.data, '$.id') AS part_id, json_extract(m.data, '$.role') AS role, ` +
      `json_extract(p.data, '$.type') AS part_type, json_extract(p.data, '$.text') AS text, json_extract(p.data, '$.tool') AS tool, ` +
      `json_extract(p.data, '$.state.output') AS tool_output, json_extract(p.data, '$.state.input') AS tool_input, ` +
      `json_extract(p.data, '$.state.status') AS tool_status, json_extract(p.data, '$.state.error') AS tool_error, ` +
      `json_extract(p.data, '$.callID') AS call_id, ` +
      `json_extract(p.data, '$.mime') AS mime, json_extract(p.data, '$.filename') AS filename, json_extract(p.data, '$.url') AS url ` +
      `FROM part p JOIN message m ON p.message_id = m.id ` +
      `WHERE p.session_id = '${sessionId}' AND json_extract(p.data, '$.synthetic') IS NOT 1 ORDER BY p.rowid ASC;`,
  );
  const items: Item[] = [];
  for (const row of rows) {
    const role = row['role'];
    const type = row['part_type'];
    const text = String(row['text'] ?? '');
    if (role === 'user' && type === 'text') {
      if (text.length > 0) items.push({ kind: 'user_text', text });
    } else if (role === 'assistant' && type === 'text') {
      if (text.length > 0) items.push({ kind: 'assistant_text', text });
    } else if (type === 'file') {
      const url = String(row['url'] ?? '');
      if (url.startsWith('data:')) {
        const comma = url.indexOf(',');
        const data = comma >= 0 ? url.slice(comma + 1) : '';
        items.push({
          kind: 'attachment',
          name: String(row['filename'] ?? ''),
          mime: String(row['mime'] ?? ''),
          contentHash: createHash('sha256').update(data, 'base64').digest('hex'),
        });
      } else {
        items.push({
          kind: 'attachment',
          name: String(row['filename'] ?? ''),
          mime: String(row['mime'] ?? ''),
          uri: url,
        });
      }
    } else if (role === 'assistant' && type === 'tool' && row['tool']) {
      const rawStatus = String(row['tool_status'] ?? '');
      const output = String(row['tool_output'] ?? '');
      const errorText = String(row['tool_error'] ?? '');
      const status =
        rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'pending'
          ? rawStatus
          : rawStatus === 'error'
            ? 'failed'
            : output || errorText
              ? 'completed'
              : 'running';
      items.push({
        kind: 'tool',
        name: String(row['tool']),
        input: String(row['tool_input'] ?? ''),
        output: errorText ? (output ? `${errorText}\n${output}` : errorText) : output,
        status,
        isError: errorText.length > 0,
        toolCallId: String(row['call_id'] ?? ''),
      });
    }
  }
  return items;
}

function v2Items(specs: ReturnType<typeof restoreHistoryEvents>): Item[] {
  const items: Item[] = [];
  const byPart = new Map<string, { item: Item; index: number }>();
  const toolIndexById = new Map<string, number>();
  for (const spec of specs) {
    const partId = String(spec.payload['partId'] ?? '');
    const delta = String(spec.payload['delta'] ?? '');
    if (spec.type === 'text_delta' || spec.type === 'thinking_delta') {
      if (spec.type === 'thinking_delta') continue; // reasoning：v2 相对 v1 的明确增量改进（豁免统计，不计入严格比对）
      const key = `${String(spec.payload['role'] ?? 'assistant')}:${partId}`;
      const existing = byPart.get(key);
      if (existing && existing.item.kind !== 'attachment' && existing.item.kind !== 'tool') {
        existing.item.text += delta;
      } else {
        const item: Item = {
          kind: spec.payload['role'] === 'user' ? 'user_text' : 'assistant_text',
          text: delta,
          synthetic: spec.payload['syntheticSummary'] === true,
        };
        byPart.set(key, { item, index: items.length });
        items.push(item);
      }
      for (const attachment of (spec.payload['attachments'] as Array<Record<string, unknown>> | undefined) ?? []) {
        items.push({
          kind: 'attachment',
          name: String(attachment['name'] ?? ''),
          mime: String(attachment['mime'] ?? ''),
          ...(typeof attachment['uri'] === 'string' ? { uri: attachment['uri'] } : {}),
          ...(typeof attachment['contentHash'] === 'string' ? { contentHash: attachment['contentHash'] } : {}),
        });
      }
    } else if (spec.type === 'tool_use') {
      const id = String(spec.payload['toolCallId'] ?? '');
      const existingIndex = toolIndexById.get(id);
      const input = JSON.stringify(spec.payload['input'] ?? {});
      if (existingIndex !== undefined) {
        const item = items[existingIndex] as Extract<Item, { kind: 'tool' }>;
        if (item.input === '{}') item.input = input;
        if (item.status === 'pending') item.status = String(spec.payload['status'] ?? 'running');
      } else {
        toolIndexById.set(id, items.length);
        items.push({
          kind: 'tool',
          name: String(spec.payload['name'] ?? 'tool'),
          input,
          output: '',
          status: String(spec.payload['status'] ?? 'running'),
          isError: false,
          toolCallId: id,
        });
      }
    } else if (spec.type === 'tool_result') {
      const id = String(spec.payload['toolCallId'] ?? '');
      const index = toolIndexById.get(id);
      const isError = spec.payload['isError'] === true;
      if (index !== undefined) {
        const item = items[index] as Extract<Item, { kind: 'tool' }>;
        item.output = String(spec.payload['content'] ?? '');
        item.status = isError ? 'failed' : 'completed';
        item.isError = isError;
      } else {
        toolIndexById.set(id, items.length);
        items.push({
          kind: 'tool',
          name: 'tool',
          input: '{}',
          output: String(spec.payload['content'] ?? ''),
          status: isError ? 'failed' : 'completed',
          isError,
          toolCallId: id,
        });
      }
    }
  }
  return items;
}



const found = await discoverOpenCodeService();
if (!found.ok) {
  console.error(`discover failed: ${found.reason}`);
  process.exit(2);
}
const client = new OpenCodeV2Client({ baseUrl: found.endpoint.baseUrl, password: found.endpoint.password });

const stats = sql(
  `SELECT
     (SELECT COUNT(*) FROM session WHERE id NOT IN (SELECT id FROM session_v2)) AS v1_only,
     (SELECT COUNT(*) FROM session_v2 WHERE id NOT IN (SELECT id FROM session)) AS v2_only,
     (SELECT COUNT(*) FROM session WHERE id IN (SELECT id FROM session_v2)) AS both;`,
)[0]!;
console.log(
  `migration-stats v1_only=${stats['v1_only']} v2_only=${stats['v2_only']} intersection=${stats['both']}`,
);

const limit = Number(process.argv[2] ?? 8);
const mode = process.argv[3] ?? 'tools';
const where =
  mode === 'plain'
    ? `s.id NOT IN (SELECT DISTINCT session_id FROM part WHERE json_extract(data,'$.type')='tool')`
    : `s.id IN (SELECT DISTINCT session_id FROM part WHERE json_extract(data,'$.type')='tool')`;
const candidates = sql(
  `SELECT s.id FROM session s WHERE s.id IN (SELECT id FROM session_v2) AND ${where} ` +
    `ORDER BY s.time_updated DESC LIMIT ${limit};`,
).map((r) => String(r['id']));

let failedSessions = 0;
let totalV1 = 0;
let totalMatched = 0;
let allowedExtra = 0;
let knownTruncations = 0;
let fatalExtra = 0;
const diffIssues: string[] = [];
let diffUnverified = 0;

for (const sessionId of candidates) {
  const old = v1Items(sessionId);
  const messages = await client.listAllMessages(sessionId);
  const specs = restoreHistoryEvents(messages);
  const current = v2Items(specs);

  // 严格有序匹配：按时间线顺序逐位对齐；synthetic 展示摘要（空文本附件消息）允许跳过
  let matched = 0;
  let truncated = 0;
  let cursor = 0;
  const missing: Item[] = [];
  for (const item of old) {
    while (cursor < current.length && current[cursor]!.kind === 'user_text' && (current[cursor] as { synthetic?: boolean }).synthetic) {
      allowedExtra += 1;
      cursor += 1;
    }
    const verdict = cursor < current.length ? compareItems(sessionId, item, current[cursor]!) : 'mismatch';
    if (verdict === 'equal') {
      matched += 1;
      cursor += 1;
    } else if (verdict === 'v1-truncated') {
      matched += 1;
      truncated += 1;
      cursor += 1;
    } else {
      missing.push(item);
    }
  }
  while (cursor < current.length && current[cursor]!.kind === 'user_text' && (current[cursor] as { synthetic?: boolean }).synthetic) {
    allowedExtra += 1;
    cursor += 1;
  }
  const extras = current.length - cursor;
  totalV1 += old.length;
  totalMatched += matched;
  fatalExtra += extras;
  knownTruncations += truncated;
  const ok = missing.length === 0 && extras === 0;
  if (!ok) failedSessions += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${sessionId} v1=${old.length} matched=${matched} knownV1Truncations=${truncated} missing=${missing.length} fatalExtra=${extras}`,
  );
  for (const m of missing.slice(0, 3)) {
    console.log(`   missing@cursor: ${m.kind} ${JSON.stringify(m).slice(0, 140)}`);
  }
  if (!ok && process.env['DEBUG_ALIGN']) {
    console.log('   v1:', old.map((i) => i.kind === 'tool' ? `T/${i.name}` : i.kind === 'attachment' ? 'A' : i.kind[0]).join(' '));
    console.log('   v2:', current.map((i) => i.kind === 'tool' ? `T/${i.name}` : i.kind === 'attachment' ? 'A' : ((i as {synthetic?:boolean}).synthetic ? 's' : i.kind[0])).join(' '));
  }

  // Diff：verifySessionDiffs 统一验证（白名单仅豁免真实 HTTP 500，其余 fail-closed）
  const verdict = await verifySessionDiffs({
    sessionId,
    messages,
    client,
    v1Base: 'http://127.0.0.1:4096',
    doFetch: fetch,
  });
  if (verdict.status === 'ok') {
    console.log(
      `   diff: deterministic=${verdict.deterministic} unique=${verdict.unique} v1Files=${verdict.v1Files} v2Files=${verdict.v2Files} filesEqual=${verdict.filesEqual}`,
    );
  } else if (verdict.status === 'unverified') {
    diffUnverified += 1;
    console.log(`   diff: UNVERIFIED (${verdict.reason})`);
  } else {
    diffIssues.push(`${sessionId}: ${verdict.reason}`);
    console.log(`   diff: FATAL ${verdict.reason.slice(0, 100)}`);
  }
}

console.log('---');
console.log(
  `mode=${mode} sessions=${candidates.length} failed=${failedSessions} v1Items=${totalV1} orderedMatched=${totalMatched} knownV1Truncations=${knownTruncations} allowedExtra(synthetic)=${allowedExtra} fatalExtra=${fatalExtra} diffVerified=${candidates.length - diffUnverified} diffUnverified=${diffUnverified} diffIssues=${diffIssues.length}`,
);
process.exit(failedSessions > 0 || diffIssues.length > 0 ? 1 : 0);
