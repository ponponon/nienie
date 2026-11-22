import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import { CodexAdapter, type CodexProcessHandle } from '../src/index.js';

/** sqlite3 CLI 是否可用——生产代码本身就靠它读 Codex 历史库。 */
function hasSqlite3(): boolean {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const sqlite3Available = hasSqlite3();

/**
 * 本地开发允许跳过（缺少 sqlite3 CLI 时给出提示），但 CI 必须真跑：
 * 否则「sqlite3 不可用 → 历史库读不到 → 手机端会话列表变空」这类回归会静默漏过。
 */
if (!sqlite3Available && (process.env.CI === 'true' || process.env.NIENIE_REQUIRE_SQLITE === '1')) {
  throw new Error('sqlite3 CLI 不可用，但当前环境要求必须跑 Codex 历史库回归测试');
}

const PROJECT = '/workspace/nienie';

type ThreadSeed = {
  id: string;
  title: string;
  source: string;
  archived?: number;
  updatedAt?: number;
};

/**
 * 复刻真实 `state_5.sqlite` 的最小 threads 表：
 * 同一项目下既有 Codex UI 展示的交互式会话，也有它从不展示的内部线程。
 * 来源白名单口径见 codex-rs `INTERACTIVE_SESSION_SOURCES`：
 * cli / vscode / custom("atlas") / custom("chatgpt")。
 */
const INTERACTIVE_IDS = ['th_vscode', 'th_cli', 'th_chatgpt', 'th_atlas'];

const SEEDS: ThreadSeed[] = [
  // Codex UI 会展示的交互式来源
  {
    id: 'th_vscode',
    title: '使用 ip-as-logo-skill 帮我生成 小猫 的 logo',
    source: 'vscode',
    updatedAt: 3000,
  },
  { id: 'th_cli', title: '提交现有的未提交的代码', source: 'cli', updatedAt: 2500 },
  { id: 'th_chatgpt', title: 'Codex 桌面端会话', source: '{"custom":"chatgpt"}', updatedAt: 2000 },
  { id: 'th_atlas', title: 'Atlas 会话', source: '{"custom":"atlas"}', updatedAt: 1500 },
  // Codex UI 从不展示的内部线程
  {
    id: 'th_subagent_spawn',
    title: '',
    source:
      '{"subagent":{"thread_spawn":{"parent_thread_id":"th_vscode","depth":1,"agent_path":"/root/logo_a","agent_nickname":"Aristotle","agent_role":null}}}',
    updatedAt: 2950,
  },
  { id: 'th_subagent_review', title: 'Review', source: '{"subagent":"review"}', updatedAt: 2940 },
  { id: 'th_subagent_compact', title: 'Compact', source: '{"subagent":"compact"}', updatedAt: 2930 },
  { id: 'th_guardian', title: 'Guardian review', source: '{"subagent":{"other":"guardian"}}', updatedAt: 2800 },
  { id: 'th_internal_guardian', title: '', source: '{"internal":{"guardian":{}}}', updatedAt: 2750 },
  { id: 'th_internal_memory', title: '', source: '{"internal":{"memory":{}}}', updatedAt: 2740 },
  { id: 'th_exec', title: '1+1等于几', source: 'exec', updatedAt: 2700 },
  { id: 'th_mcp', title: 'MCP 调用', source: 'mcp', updatedAt: 2650 },
  // 未知来源：未来第三方工具注册的 custom 名称，官方白名单不含，必须过滤
  { id: 'th_unknown_custom', title: '未知工具会话', source: '{"custom":"some_future_agent"}', updatedAt: 2620 },
  { id: 'th_unknown', title: '未知来源会话', source: 'unknown', updatedAt: 2610 },
  // 归档线程
  { id: 'th_archived', title: '已归档会话', source: 'vscode', archived: 1, updatedAt: 2600 },
];

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** SQL 字面量转义（测试标题里出现单引号也不会把 INSERT 弄坏）。 */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(dbPath: string, statements: string[]): void {
  for (const statement of statements) {
    execFileSync('sqlite3', [dbPath, statement], { stdio: 'ignore' });
  }
}

function createCodexHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nienie-codex-home-'));
  createdDirs.push(dir);
  const dbPath = join(dir, 'state_5.sqlite');
  runSql(dbPath, [
    'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", cwd TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);',
    ...SEEDS.map((seed) => {
      const updatedAt = seed.updatedAt ?? 1000;
      return `INSERT INTO threads (id, title, cwd, created_at, updated_at, source, archived) VALUES (${sqlText(seed.id)}, ${sqlText(seed.title)}, ${sqlText(PROJECT)}, ${updatedAt - 500}, ${updatedAt}, ${sqlText(seed.source)}, ${seed.archived ?? 0});`;
    }),
  ]);
  return dir;
}

/** 最小 thread_history 库：只建回放需要的表。 */
function seedThreadHistory(dir: string, threadId: string): void {
  runSql(join(dir, 'thread_history_1.sqlite'), [
    'CREATE TABLE thread_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL, item_type TEXT NOT NULL, item_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, rollout_ordinal INTEGER NOT NULL);',
    `INSERT INTO thread_items VALUES (${sqlText(threadId)}, 'item_user', 'userMessage', ${sqlText(JSON.stringify({ id: 'item_user', type: 'userMessage', content: [{ type: 'text', text: '手机端发来的历史问题' }] }))}, 1700000000000, 1);`,
    `INSERT INTO thread_items VALUES (${sqlText(threadId)}, 'item_agent', 'agentMessage', ${sqlText(JSON.stringify({ id: 'item_agent', type: 'agentMessage', text: '历史回答' }))}, 1700000001000, 2);`,
  ]);
}

/** 只吐一行 `thread.started` 就退出的假 Codex 进程，用于把内存会话绑到真实 thread_id。 */
function createFakeProcess(threadId: string): CodexProcessHandle {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  setTimeout(() => {
    stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
    stdout.end();
    emitter.emit('exit', 0);
  }, 0);
  return {
    stdout,
    stderr,
    kill() {
      emitter.emit('exit', 130);
    },
    onExit(listener) {
      emitter.once('exit', listener);
    },
    onError(listener) {
      emitter.once('error', listener);
    },
    onSpawn(listener) {
      emitter.once('spawn', listener);
      emitter.emit('spawn');
    },
  };
}

describe('CodexAdapter 本地历史列表', () => {
  it.skipIf(!sqlite3Available)(
    '只列 Codex UI 展示的交互式会话，过滤 subagent / guardian / internal / mcp / exec / 未知来源 / 归档线程',
    async () => {
      const adapter = new CodexAdapter({
        codexHome: createCodexHome(),
        defaultProjectPath: PROJECT,
      });

      const sessions = await adapter.listSessions();
      const ids = sessions.map((session) => session.id);

      // 只保留 cli / vscode / custom(atlas|chatgpt) 四种官方交互式来源
      expect(ids.sort()).toEqual([...INTERACTIVE_IDS].sort());
      // 未知 custom、mcp、internal、unknown 全部被过滤
      expect(ids).not.toContain('th_unknown_custom');
      expect(ids).not.toContain('th_mcp');
      expect(ids).not.toContain('th_internal_guardian');
      expect(ids).not.toContain('th_internal_memory');
      expect(ids).not.toContain('th_unknown');
      // 子 Agent / guardian / exec / 归档同样不出现
      expect(ids).not.toContain('th_subagent_spawn');
      expect(ids).not.toContain('th_subagent_review');
      expect(ids).not.toContain('th_subagent_compact');
      expect(ids).not.toContain('th_guardian');
      expect(ids).not.toContain('th_exec');
      expect(ids).not.toContain('th_archived');
      // 空标题兜底（「Codex (nienie)」）不该再有机会出现
      expect(sessions.some((session) => session.title.startsWith('Codex ('))).toBe(false);

      // 项目路径与时间戳映射正确（updated_at 秒 → ISO）
      const vscode = sessions.find((session) => session.id === 'th_vscode')!;
      expect(vscode.projectPath).toBe(PROJECT);
      expect(vscode.updatedAt).toBe(new Date(3000 * 1000).toISOString());
      expect(vscode.status).toBe('idle');
    },
  );

  it.skipIf(!sqlite3Available)('内存会话绑定的 threadId 不会被历史库重复列一遍', async () => {
    const adapter = new CodexAdapter({
      codexHome: createCodexHome(),
      defaultProjectPath: PROJECT,
      // 显式打开历史发现：注入假进程后默认会关闭，这里要同时验证两者共存
      discoverLocalHistory: true,
      spawnProcess: () => createFakeProcess('th_vscode'),
    });

    const created = await adapter.createSession({ title: '手机端新建的会话', projectPath: PROJECT });
    await adapter.sendMessage(created.id, '你好');
    await adapter.waitForRun(created.id);

    const sessions = await adapter.listSessions();
    // th_vscode 已经被内存会话占用，历史库里的同一条不能又列一遍
    expect(sessions.some((session) => session.id === 'th_vscode')).toBe(false);
    expect(sessions.some((session) => session.id === created.id)).toBe(true);
    expect(sessions).toHaveLength(INTERACTIVE_IDS.length);
  });

  it.skipIf(!sqlite3Available)('历史回放读的是注入的 codexHome 下的 thread_history 库', async () => {
    const codexHome = createCodexHome();
    seedThreadHistory(codexHome, 'th_vscode');
    const adapter = new CodexAdapter({ codexHome, defaultProjectPath: PROJECT });

    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.loadSession('th_vscode');

    const deltas = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event.payload as { delta?: string }).delta ?? '');
    expect(deltas.some((delta) => delta.includes('手机端发来的历史问题'))).toBe(true);
    expect(deltas.some((delta) => delta.includes('历史回答'))).toBe(true);
  });

  it.skipIf(!sqlite3Available)('历史库不存在时不影响内存会话列表', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'nienie-codex-empty-'));
    createdDirs.push(emptyHome);
    const adapter = new CodexAdapter({ codexHome: emptyHome, defaultProjectPath: PROJECT });

    const created = await adapter.createSession({ title: '手机端新建的会话', projectPath: PROJECT });
    const sessions = await adapter.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(created.id);
  });
});
