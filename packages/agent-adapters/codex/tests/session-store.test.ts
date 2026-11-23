import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import { CodexAdapter, CodexSessionStore, type CodexProcessHandle } from '../src/index.js';

const PROJECT = '/workspace/nienie';
const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(dbPath: string, statements: string[]): void {
  for (const statement of statements) {
    execFileSync('sqlite3', [dbPath, statement], { stdio: 'ignore' });
  }
}

/** 只吐一行 `thread.started` 就退出的假 Codex 进程。 */
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

/** 一个「Codex 桌面端会话」：source=vscode，会被历史库发现。 */
function seedDesktopThread(codexHome: string, threadId: string, title: string): void {
  runSql(join(codexHome, 'state_5.sqlite'), [
    'CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", cwd TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL DEFAULT "");',
    `INSERT OR REPLACE INTO threads VALUES (${sqlText(threadId)}, ${sqlText(title)}, ${sqlText(PROJECT)}, 1700000000, 1700000001, 'vscode', 0, ${sqlText(title)});`,
  ]);
}

function seedThreadHistory(codexHome: string, threadId: string): void {
  runSql(join(codexHome, 'thread_history_1.sqlite'), [
    'CREATE TABLE IF NOT EXISTS thread_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL, item_type TEXT NOT NULL, item_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, rollout_ordinal INTEGER NOT NULL);',
    `INSERT INTO thread_items VALUES (${sqlText(threadId)}, 'item_agent', 'agentMessage', ${sqlText(JSON.stringify({ id: 'item_agent', type: 'agentMessage', text: '重启前的回答' }))}, 1700000001000, 1);`,
  ]);
}

function textDeltas(events: CanonicalAgentEvent[]): string[] {
  return events
    .filter((event) => event.type === 'text_delta')
    .map((event) => (event.payload as { delta?: string }).delta ?? '');
}

describe('CodexSessionStore', () => {
  it('写入即可读回，且不留临时文件', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'nested', 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([
      {
        id: 'codex_ses_a',
        threadId: 'th_a',
        title: '手机端任务',
        projectPath: PROJECT,
        status: 'idle',
        createdAt: '2026-11-23T00:00:00.000Z',
        updatedAt: '2026-11-23T00:10:00.000Z',
      },
    ]);

    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'codex_ses_a', threadId: 'th_a', title: '手机端任务' });
    // 原子写：目录里只应有最终文件，没有 .tmp 残留
    expect(readdirSync(join(dir, 'nested'))).toEqual(['codex-sessions.json']);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1);
  });

  it('按 updatedAt 倒序截断到 maxSessions', () => {
    const store = new CodexSessionStore({
      filePath: join(makeDir('nienie-store-'), 'codex-sessions.json'),
      maxSessions: 2,
    });
    const base = {
      projectPath: PROJECT,
      status: 'idle' as const,
      createdAt: '2026-11-23T00:00:00.000Z',
    };
    store.save([
      { ...base, id: 'codex_ses_old', title: 'old', updatedAt: '2026-11-01T00:00:00.000Z' },
      { ...base, id: 'codex_ses_new', title: 'new', updatedAt: '2026-11-23T00:00:00.000Z' },
      { ...base, id: 'codex_ses_mid', title: 'mid', updatedAt: '2026-11-10T00:00:00.000Z' },
    ]);

    expect(store.load().map((session) => session.id)).toEqual(['codex_ses_new', 'codex_ses_mid']);
  });

  it('文件损坏或版本不认识时返回空数组而不是抛错', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');

    writeFileSync(filePath, 'not json at all', 'utf8');
    expect(new CodexSessionStore({ filePath }).load()).toEqual([]);

    writeFileSync(filePath, JSON.stringify({ version: 99, sessions: [{ id: 'x' }] }), 'utf8');
    expect(new CodexSessionStore({ filePath }).load()).toEqual([]);
  });
});

describe('CodexAdapter 会话持久化', () => {
  it('Bridge 重启后恢复 Nienie 自建会话，并与 Codex 历史库按 threadId 去重', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedDesktopThread(codexHome, 'th_real_123', '桌面端同线程会话');
    seedThreadHistory(codexHome, 'th_real_123');

    // 第一次运行：手机端建会话并跑一轮，拿到真实 threadId
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      discoverLocalHistory: true,
      spawnProcess: () => createFakeProcess('th_real_123'),
    });
    const created = await first.createSession({ title: '手机端新建的会话', projectPath: PROJECT });
    await first.sendMessage(created.id, '你好');
    await first.waitForRun(created.id);
    await first.dispose();

    // 第二次启动：新实例只靠落盘索引恢复
    const second = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      discoverLocalHistory: true,
      spawnProcess: () => createFakeProcess('th_real_123'),
    });
    const sessions = await second.listSessions();
    const ids = sessions.map((session) => session.id);

    // 会话 id 保留 Nienie 自己的（不是 threadId）
    expect(ids).toContain(created.id);
    // 同一个 Codex 线程不会被历史库再列一遍
    expect(ids).not.toContain('th_real_123');
    expect(sessions.filter((session) => session.title === '桌面端同线程会话')).toHaveLength(0);

    // threadId 也恢复了：能直接回放该线程的历史
    const events: CanonicalAgentEvent[] = [];
    second.onEvent((event) => events.push(event));
    await second.loadSession(created.id);
    expect(textDeltas(events).some((delta) => delta.includes('重启前的回答'))).toBe(true);
  });

  it('重启时 running / waiting 一律降级 idle，不伪造运行中', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath: storePath });
    const base = {
      title: '手机端任务',
      projectPath: PROJECT,
      createdAt: '2026-11-23T00:00:00.000Z',
      updatedAt: '2026-11-23T00:10:00.000Z',
    };
    store.save([
      { ...base, id: 'codex_ses_running', title: '运行中', status: 'running' },
      { ...base, id: 'codex_ses_waiting', title: '等待中', status: 'waiting' },
      { ...base, id: 'codex_ses_failed', title: '失败过', status: 'failed' },
    ]);

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    const statuses = new Map(
      (await adapter.listSessions()).map((session) => [session.id, session.status]),
    );

    expect(statuses.get('codex_ses_running')).toBe('idle');
    expect(statuses.get('codex_ses_waiting')).toBe('idle');
    // 终态保留，不要把一个真失败洗成 idle
    expect(statuses.get('codex_ses_failed')).toBe('failed');
  });

  it('新建会话立刻落盘时不会覆盖此前已存的会话', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      {
        id: 'codex_ses_prev',
        threadId: 'th_prev',
        title: '上次运行的会话',
        projectPath: PROJECT,
        status: 'idle',
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T01:00:00.000Z',
      },
    ]);

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    // 没有先调 listSessions，直接新建：落盘前必须先恢复旧记录
    const created = await adapter.createSession({ title: '本次新建', projectPath: PROJECT });

    const stored = new CodexSessionStore({ filePath: storePath }).load().map((session) => session.id);
    expect(stored).toContain('codex_ses_prev');
    expect(stored).toContain(created.id);
  });

  it('没有 sessionStorePath 时行为不变（不落盘、也不读历史文件）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const adapter = new CodexAdapter({ codexHome, defaultProjectPath: PROJECT });

    const created = await adapter.createSession({ title: '纯内存会话', projectPath: PROJECT });
    const sessions = await adapter.listSessions();

    expect(sessions.map((session) => session.id)).toEqual([created.id]);
  });
});
