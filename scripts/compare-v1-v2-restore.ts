import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverOpenCodeService } from '../packages/agent-adapters/opencode/src/service-discovery.ts';
import { OpenCodeV2Client } from '../packages/agent-adapters/opencode/src/v2/client.ts';
import {
  buildSnapshotParts,
  resolveDiffTurnRange,
  restoreHistoryEvents,
} from '../packages/agent-adapters/opencode/src/v2/message-restore.ts';
import { deriveDiffId } from '../packages/agent-adapters/opencode/src/v2/diff-id.ts';

type Item =
  | { kind: 'user_text'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool'; name: string; input: string; output: string; status: string; isError: boolean };

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
    `SELECT m.id AS message_id, json_extract(p.data, '$.id') AS part_id, json_extract(m.data, '$.role') AS role, ` +
      `json_extract(p.data, '$.type') AS part_type, json_extract(p.data, '$.text') AS text, json_extract(p.data, '$.tool') AS tool, ` +
      `json_extract(p.data, '$.callID') AS call_id, json_extract(p.data, '$.state.output') AS tool_output, ` +
      `json_extract(p.data, '$.state.input') AS tool_input, json_extract(p.data, '$.state.status') AS tool_status, ` +
      `json_extract(p.data, '$.state.error') AS tool_error FROM part p JOIN message m ON p.message_id = m.id ` +
      `WHERE p.session_id = '${sessionId}' AND json_extract(p.data, '$.synthetic') IS NOT 1 ORDER BY p.rowid ASC;`,
  );
  const items: Item[] = [];
  for (const row of rows) {
    const role = row['role'];
    const type = row['part_type'];
    const text = String(row['text'] ?? '');
    if (role === 'user' && type === 'text' && text.trim()) {
      items.push({ kind: 'user_text', text });
    } else if (role === 'assistant' && type === 'text' && text) {
      items.push({ kind: 'assistant_text', text });
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
      });
    }
  }
  return items;
}

function v2Items(sessionId: string, specs: ReturnType<typeof restoreHistoryEvents>): Item[] {
  const items: Item[] = [];
  const byPart = new Map<string, { kind: 'user_text' | 'assistant_text'; text: string; index: number }>();
  const tools = new Map<string, Item & { kind: 'tool' }>();
  for (const spec of specs) {
    const partId = String(spec.payload['partId'] ?? '');
    const delta = String(spec.payload['delta'] ?? '');
    if (spec.type === 'text_delta' || spec.type === 'thinking_delta') {
      if (spec.type === 'thinking_delta') continue; // reasoning 是 v2 相对 v1 的增量改进，不参与 v1 可见集合比对
      const key = `${String(spec.payload['role'] ?? 'assistant')}:${partId}`;
      const existing = byPart.get(key);
      if (existing) {
        existing.text += delta;
      } else {
        byPart.set(key, {
          kind: spec.payload['role'] === 'user' ? 'user_text' : 'assistant_text',
          text: delta,
          index: byPart.size,
        });
      }
    } else if (spec.type === 'tool_use') {
      const id = String(spec.payload['toolCallId'] ?? '');
      const prev = tools.get(id);
      const input = JSON.stringify(spec.payload['input'] ?? {});
      tools.set(id, {
        kind: 'tool',
        name: String(spec.payload['name'] ?? 'tool'),
        input,
        output: prev?.output ?? '',
        status: String(spec.payload['status'] ?? 'running'),
        isError: prev?.isError ?? false,
      });
    } else if (spec.type === 'tool_result') {
      const id = String(spec.payload['toolCallId'] ?? '');
      const prev = tools.get(id);
      const isError = spec.payload['isError'] === true;
      tools.set(id, {
        kind: 'tool',
        name: prev?.name ?? 'tool',
        input: prev?.input ?? '{}',
        output: String(spec.payload['content'] ?? ''),
        status: isError ? 'failed' : 'completed',
        isError,
      });
    }
  }
  for (const entry of [...byPart.entries()].sort((a, b) => a[1].index - b[1].index)) {
    items.push({ kind: entry[1].kind, text: entry[1].text });
  }
  for (const tool of tools.values()) items.push(tool);
  return items;
}

function semanticEqual(a: Item, b: Item): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tool' && b.kind === 'tool') {
    const inputA = normalizeInput(a.input);
    const inputB = normalizeInput(b.input);
    const outputOk = a.output === b.output || (a.output.length > 0 && b.output.includes(a.output));
    return a.name === b.name && inputA === inputB && a.status === b.status && a.isError === b.isError && outputOk;
  }
  const textA = (a as { text: string }).text;
  const textB = (b as { text: string }).text;
  return textA === textB || (textA.length > 0 && textB.includes(textA));
}

function normalizeInput(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

const found = await discoverOpenCodeService();
if (!found.ok) {
  console.error(`discover failed: ${found.reason}`);
  process.exit(2);
}
const client = new OpenCodeV2Client({ baseUrl: found.endpoint.baseUrl, password: found.endpoint.password });

const limit = Number(process.argv[2] ?? 8);
const candidates = sql(
  `SELECT s.id FROM session s WHERE s.id IN (SELECT id FROM session_v2) ` +
    `AND s.id IN (SELECT DISTINCT session_id FROM part WHERE json_extract(data,'$.type')='tool') ` +
    `ORDER BY s.time_updated DESC LIMIT ${limit};`,
).map((r) => String(r['id']));

let totalSessions = 0;
let failedSessions = 0;
let totalV1 = 0;
let totalMatched = 0;
let totalExtraV2 = 0;
const diffMismatches: string[] = [];

for (const sessionId of candidates) {
  totalSessions += 1;
  const old = v1Items(sessionId);
  const messages = await client.listAllMessages(sessionId);
  const specs = restoreHistoryEvents(messages);
  const current = v2Items(sessionId, specs);

  const used = new Set<number>();
  let matched = 0;
  const missing: Item[] = [];
  for (const item of old) {
    const idx = current.findIndex((c, i) => !used.has(i) && semanticEqual(item, c));
    if (idx >= 0) {
      used.add(idx);
      matched += 1;
    } else {
      missing.push(item);
    }
  }
  const extra = current.length - used.size;
  totalV1 += old.length;
  totalMatched += matched;
  totalExtraV2 += extra;
  const ok = missing.length === 0;
  if (!ok) failedSessions += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${sessionId} v1=${old.length} matched=${matched} missing=${missing.length} v2Extra=${extra}`,
  );
  for (const m of missing) {
    console.log(`   missing: ${m.kind} ${JSON.stringify(m).slice(0, 140)}`);
  }

  // Diff 对照：v1 diff API vs v2 turn 范围 diff + diffId 稳定性
  try {
    const v2Range = resolveDiffTurnRange(messages);
    const v2Diffs = await client.getSessionDiff(sessionId, { from: v2Range.fromMessageId, to: v2Range.toMessageId });
    const v2Files = new Set(v2Diffs.map((d) => d.file));
    const ids = v2Diffs.map((d) =>
      deriveDiffId({
        sessionId,
        fromMessageId: v2Range.fromMessageId,
        toMessageId: v2Range.toMessageId,
        file: d.file,
        patch: d.patch,
      }),
    );
    const stable = new Set(ids).size === ids.length;
    const snapshotParts = buildSnapshotParts(messages).length;
    if (!stable) diffMismatches.push(`${sessionId}: diffId 不唯一`);
    console.log(
      `   diff: v2Files=${v2Files.size} diffIdStable=${stable} range=${v2Range.fromMessageId}..${v2Range.toMessageId} snapshotParts=${snapshotParts}`,
    );
  } catch (error) {
    diffMismatches.push(`${sessionId}: ${String(error)}`);
    console.log(`   diff: ERROR ${String(error)}`);
  }
}

console.log('---');
console.log(
  `sessions=${totalSessions} failed=${failedSessions} v1Items=${totalV1} matched=${totalMatched} v2Extra(reasoning 等)=${totalExtraV2} diffIssues=${diffMismatches.length}`,
);
process.exit(failedSessions > 0 || diffMismatches.length > 0 ? 1 : 0);
