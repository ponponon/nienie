import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/index.js';

/** sqlite3 CLI 是否可用——历史库读取依赖它，缺失时跳过而不是误判失败。 */
function hasSqlite3(): boolean {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
 */
const SEEDS: ThreadSeed[] = [
  // Codex UI 会展示的交互式来源（cli / vscode / custom）
  { id: 'th_vscode', title: '使用 ip-as-logo-skill 帮我生成 小猫 的 logo', source: 'vscode', updatedAt: 3000 },
  { id: 'th_cli', title: '提交现有的未提交的代码', source: 'cli', updatedAt: 2500 },
  { id: 'th_chatgpt', title: 'Codex 桌面端会话', source: '{"custom":"chatgpt"}', updatedAt: 2000 },
  { id: 'th_atlas', title: 'Atlas 会话', source: '{"custom":"atlas"}', updatedAt: 1500 },
  // Codex UI 从不展示的内部线程
  {
    id: 'th_subagent',
    title: '',
    source:
      '{"subagent":{"thread_spawn":{"parent_thread_id":"th_vscode","depth":1,"agent_path":"/root/logo_a","agent_nickname":"Aristotle","agent_role":null}}}',
    updatedAt: 2900,
  },
  { id: 'th_guardian', title: 'Guardian review', source: '{"subagent":{"other":"guardian"}}', updatedAt: 2800 },
  { id: 'th_exec', title: '1+1等于几', source: 'exec', updatedAt: 2700 },
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

function createCodexHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nienie-codex-home-'));
  createdDirs.push(dir);
  const dbPath = join(dir, 'state_5.sqlite');
  const statements = [
    'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", cwd TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);',
    ...SEEDS.map(
      (seed) =>
        `INSERT INTO threads (id, title, cwd, created_at, updated_at, source, archived) VALUES ('${seed.id}', '${seed.title}', '${PROJECT}', ${(seed.updatedAt ?? 1000) - 500}, ${seed.updatedAt ?? 1000}, '${seed.source.replace(/'/g, "''")}', ${seed.archived ?? 0});`,
    ),
  ];
  for (const statement of statements) {
    execFileSync('sqlite3', [dbPath, statement], { stdio: 'ignore' });
  }
  return dir;
}

describe('CodexAdapter 本地历史列表', () => {
  it.skipIf(!hasSqlite3())(
    '只列 Codex UI 展示的交互式会话，过滤 subagent / guardian / exec / 归档线程',
    async () => {
      const codexHome = createCodexHome();
      const adapter = new CodexAdapter({ codexHome, defaultProjectPath: PROJECT });

      const sessions = await adapter.listSessions();
      const titles = sessions.map((session) => session.title).sort();

      expect(titles).toEqual(['Atlas 会话', 'Codex 桌面端会话', '使用 ip-as-logo-skill 帮我生成 小猫 的 logo', '提交现有的未提交的代码'].sort());
      // 子 Agent 线程绝不能以空标题兜底（曾表现为「Codex (nienie)」幽灵会话）
      expect(titles.some((title) => title.startsWith('Codex ('))).toBe(false);
      expect(sessions.map((session) => session.id)).not.toContain('th_exec');
      expect(sessions.map((session) => session.id)).not.toContain('th_subagent');
      expect(sessions.map((session) => session.id)).not.toContain('th_archived');

      // 项目路径与时间戳映射正确（updated_at 秒 → ISO）
      const vscode = sessions.find((session) => session.id === 'th_vscode')!;
      expect(vscode.projectPath).toBe(PROJECT);
      expect(vscode.updatedAt).toBe(new Date(3000 * 1000).toISOString());
      expect(vscode.status).toBe('idle');
    },
  );

  it.skipIf(!hasSqlite3())('历史库不存在时不影响内存会话列表', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'nienie-codex-empty-'));
    createdDirs.push(emptyHome);
    const adapter = new CodexAdapter({ codexHome: emptyHome, defaultProjectPath: PROJECT });

    const created = await adapter.createSession({ title: '手机端新建的会话', projectPath: PROJECT });
    const sessions = await adapter.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(created.id);
  });
});
