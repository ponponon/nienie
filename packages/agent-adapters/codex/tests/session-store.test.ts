import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import {
  CodexAdapter,
  CodexSessionStore,
  type CodexProcessHandle,
  type CodexStoredSession,
} from '../src/index.js';

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

/** `load()` 现在是四态联合：测试里绝大多数场景只关心「读到了什么」。 */
function loadOk(store: CodexSessionStore): CodexStoredSession[] {
  const result = store.load();
  if (result.status !== 'ok') throw new Error(`expected status ok, got ${result.status}`);
  return result.sessions;
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

const STORE_BASE = {
  title: '手机端任务',
  projectPath: PROJECT,
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:10:00.000Z',
};

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
        runState: 'started',
        createdAt: '2026-11-23T00:00:00.000Z',
        updatedAt: '2026-11-23T00:10:00.000Z',
      },
    ]);

    const loaded = loadOk(store);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: 'codex_ses_a',
      threadId: 'th_a',
      title: '手机端任务',
      runState: 'started',
    });
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

    expect(loadOk(store).map((session) => session.id)).toEqual([
      'codex_ses_new',
      'codex_ses_mid',
    ]);
  });

  it('文件不存在 / 损坏 / 版本不认识时区分状态，而不是一律返回空数组', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');

    // 没有文件 ≠ 文件坏了：前者是正常首次启动，后者必须隔离
    expect(new CodexSessionStore({ filePath }).load()).toEqual({ status: 'missing' });

    writeFileSync(filePath, 'not json at all', 'utf8');
    expect(new CodexSessionStore({ filePath }).load()).toEqual({ status: 'corrupt' });

    writeFileSync(filePath, JSON.stringify({ version: 99, sessions: [{ id: 'x' }] }), 'utf8');
    expect(new CodexSessionStore({ filePath }).load()).toEqual({ status: 'unsupported' });

    writeFileSync(filePath, JSON.stringify({ version: 1, sessions: 'nope' }), 'utf8');
    expect(new CodexSessionStore({ filePath }).load()).toEqual({ status: 'corrupt' });

    // 数组里只要有一条结构非法，整份都算 corrupt——静默过滤掉那条，下次 save 就永久丢了
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, sessions: [{ id: 'codex_ses_a', title: '缺字段' }] }),
      'utf8',
    );
    expect(new CodexSessionStore({ filePath }).load()).toEqual({ status: 'corrupt' });
  });

  it('save 对读不动的文件 fail-closed：拒绝覆盖，原文件一字不动', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const futureContent = JSON.stringify({ version: 99, sessions: [] });
    writeFileSync(filePath, futureContent, 'utf8');
    const store = new CodexSessionStore({ filePath });

    expect(() => store.save([{ ...STORE_BASE, id: 'codex_ses_new', title: '新', status: 'idle' }]))
      .toThrow(/refusing to overwrite/);
    // 核心断言：覆盖没发生（这层保护不能依赖调用方先隔离）
    expect(readFileSync(filePath, 'utf8')).toBe(futureContent);

    // 损坏文件同理
    writeFileSync(filePath, '{"version":1,"sessions":', 'utf8');
    expect(() => store.save([{ ...STORE_BASE, id: 'codex_ses_x', title: 'x', status: 'idle' }]))
      .toThrow(/refusing to overwrite/);
    expect(readFileSync(filePath, 'utf8')).toBe('{"version":1,"sessions":');
  });

  it('坏文件可以被隔离改名，原内容不丢', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const original = JSON.stringify({ version: 99, sessions: [{ id: 'future' }] });
    writeFileSync(filePath, original, 'utf8');

    const backupPath = new CodexSessionStore({ filePath }).quarantine('unsupported');

    expect(backupPath).toBeDefined();
    expect(existsSync(filePath)).toBe(false);
    // 备份文件名要能看出原因，方便用户手工找回
    expect(backupPath).toContain('.unsupported.');
    expect(backupPath!.endsWith('.bak')).toBe(true);
    expect(readFileSync(backupPath!, 'utf8')).toBe(original);
  });

  it('save 先读盘合并：不会覆盖另一个实例已写的会话', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const first = new CodexSessionStore({ filePath });
    const second = new CodexSessionStore({ filePath });

    first.save([{ ...STORE_BASE, id: 'codex_ses_a', title: 'A', status: 'idle' }]);
    // 第二个实例没读过盘就直接写：合并后 A 必须还在
    second.save([{ ...STORE_BASE, id: 'codex_ses_b', title: 'B', status: 'idle' }]);

    expect(loadOk(first).map((session) => session.id).sort()).toEqual([
      'codex_ses_a',
      'codex_ses_b',
    ]);
  });

  it('写锁被活进程持有时拒绝写盘（不无锁覆盖），成功写完不留锁文件', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([{ ...STORE_BASE, id: 'codex_ses_keep', title: '原有会话', status: 'idle' }]);
    // 正常路径写完必须清掉锁，否则下次启动会以为有人一直持锁
    expect(existsSync(`${filePath}.lock`)).toBe(false);

    // 另一个「活着的进程」（用当前 pid 冒充）正持锁
    writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
    expect(() =>
      store.save([{ ...STORE_BASE, id: 'codex_ses_new', title: '抢不到锁', status: 'idle' }]),
    ).toThrow(/locked by another writer/);
    // 拒绝而不是覆盖：原数据必须完好
    expect(loadOk(store).map((session) => session.id)).toEqual(['codex_ses_keep']);
  });

  it('threadId 只增不减：旧快照不能抹掉已绑定的线程', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_bound',
        title: '已绑定线程',
        status: 'idle',
        threadId: 'th_bound',
        runState: 'started',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ]);
    // 另一个实例拿着「还没有 threadId」的旧快照后写，且时间戳更新
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_bound',
        title: '已绑定线程',
        status: 'running',
        runState: 'starting',
        updatedAt: '2026-11-23T00:05:00.000Z',
      },
    ]);

    expect(loadOk(store)[0]).toMatchObject({
      threadId: 'th_bound',
      status: 'running',
      updatedAt: '2026-11-23T00:05:00.000Z',
    });
  });

  it('活锁不会被年龄抢走，只有持有进程消失才算陈旧', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_keep', title: '原有', status: 'idle' }]);

    // 持有者还活着，但锁已经存在 10 分钟：仍然不许抢（持锁进程可能只是被挂起）
    writeFileSync(
      `${filePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now() - 600_000, token: 'other' }),
      'utf8',
    );
    expect(() =>
      store.save([{ ...STORE_BASE, id: 'codex_ses_new', title: '新', status: 'idle' }]),
    ).toThrow(/locked by another writer/);
    expect(loadOk(store).map((session) => session.id)).toEqual(['codex_ses_keep']);
  });

  it('崩溃残留的旧锁会被接管（不让一次崩溃永久禁用持久化）', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    // 持锁进程已不存在（pid 999999 基本不可能存在）
    writeFileSync(
      `${filePath}.lock`,
      JSON.stringify({ pid: 999999, at: Date.now(), token: 'dead' }),
      'utf8',
    );

    store.save([{ ...STORE_BASE, id: 'codex_ses_after_crash', title: '接管后写入', status: 'idle' }]);

    expect(loadOk(store).map((session) => session.id)).toEqual(['codex_ses_after_crash']);
    // 回收过程不留垃圾：没有 .lock / .reclaim / .new 残留
    expect(readdirSync(dir).filter((name) => name !== 'codex-sessions.json')).toEqual([]);
  });

  it('空锁文件（写入内容前就崩溃）放够时间后能自动恢复', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    // 旧版本/异常残留：内容为空，读不出持有者
    writeFileSync(`${filePath}.lock`, '', 'utf8');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${filePath}.lock`, old, old);

    store.save([{ ...STORE_BASE, id: 'codex_ses_after_empty', title: '恢复', status: 'idle' }]);

    expect(loadOk(store).map((session) => session.id)).toEqual(['codex_ses_after_empty']);
    expect(existsSync(`${filePath}.lock`)).toBe(false);
  });

  it('空锁文件还很新时不抢（可能正被写入）', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    writeFileSync(`${filePath}.lock`, '', 'utf8');
    expect(() =>
      new CodexSessionStore({ filePath }).save([
        { ...STORE_BASE, id: 'codex_ses_x', title: 'x', status: 'idle' },
      ]),
    ).toThrow(/locked by another writer/);
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

    // 跑过一轮后落盘的应该是 started + threadId（不是 starting 卡住）
    const persisted = loadOk(new CodexSessionStore({ filePath: storePath }));
    expect(persisted.find((s) => s.id === created.id)).toMatchObject({
      threadId: 'th_real_123',
      runState: 'started',
    });

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
    new CodexSessionStore({ filePath: storePath }).save([
      {
        ...STORE_BASE,
        id: 'codex_ses_running',
        title: '运行中',
        status: 'running',
        threadId: 'th_running',
        runState: 'started',
      },
      {
        ...STORE_BASE,
        id: 'codex_ses_waiting',
        title: '等待中',
        status: 'waiting',
        threadId: 'th_waiting',
        runState: 'started',
      },
      { ...STORE_BASE, id: 'codex_ses_failed', title: '失败过', status: 'failed' },
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

  it('spawn 后崩溃（starting 且没有 threadId）恢复为 failed，不伪装成空会话', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      // 崩溃窗口：已经 spawn 了 Codex，但 thread.started 还没落盘
      {
        ...STORE_BASE,
        id: 'codex_ses_interrupted',
        title: '被打断的一轮',
        status: 'running',
        runState: 'starting',
      },
      // 对照组：resume 场景本来就有 threadId，不算法「中断」
      {
        ...STORE_BASE,
        id: 'codex_ses_resumed',
        title: '能续上的会话',
        status: 'running',
        threadId: 'th_resumed',
        runState: 'starting',
      },
    ]);

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    const statuses = new Map(
      (await adapter.listSessions()).map((session) => [session.id, session.status]),
    );

    expect(statuses.get('codex_ses_interrupted')).toBe('failed');
    expect(statuses.get('codex_ses_resumed')).toBe('idle');
  });

  it('版本不认识的文件会被隔离，新版本数据不被本版本覆盖', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const dir = makeDir('nienie-store-');
    const storePath = join(dir, 'codex-sessions.json');
    const futureContent = JSON.stringify({ version: 99, sessions: [{ id: 'codex_ses_future' }] });
    writeFileSync(storePath, futureContent, 'utf8');

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    const created = await adapter.createSession({ title: '本版本新建', projectPath: PROJECT });

    // 原文件被改名隔离，内容一字未改
    const backups = readdirSync(dir).filter((name) => name.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe(futureContent);
    // 新文件里只有本版本自己的会话
    expect(loadOk(new CodexSessionStore({ filePath: storePath })).map((s) => s.id)).toEqual([
      created.id,
    ]);
    // 不能静默：必须留下诊断，否则用户永远不知道自己的会话去哪了
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain('quarantined');
  });

  it('损坏的文件同样隔离后重建，不抛错', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const dir = makeDir('nienie-store-');
    const storePath = join(dir, 'codex-sessions.json');
    writeFileSync(storePath, '{"version":1,"sessions":[', 'utf8');

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });

    // 读坏了也不能让 listSessions 整个失败
    await expect(adapter.listSessions()).resolves.toEqual([]);
    expect(readdirSync(dir).some((name) => name.includes('.corrupt.'))).toBe(true);
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

    const stored = loadOk(new CodexSessionStore({ filePath: storePath })).map((s) => s.id);
    expect(stored).toContain('codex_ses_prev');
    expect(stored).toContain(created.id);
  });

  it('spawn 失败要把 failed 落盘，且 runState 退回 never_started', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      // spawn 都没成功：Codex 那一侧没有任何进程/线程被创建
      spawnProcess: () => {
        const emitter = new EventEmitter();
        setTimeout(() => emitter.emit('error', new Error('spawn ENOENT')), 0);
        return {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill() {
            emitter.emit('exit', 130);
          },
          onExit(listener) {
            emitter.once('exit', listener);
          },
          onError(listener) {
            emitter.once('error', listener);
          },
          onSpawn() {},
        } satisfies CodexProcessHandle;
      },
    });

    const created = await adapter.createSession({ title: '起不来的会话', projectPath: PROJECT });
    await expect(adapter.sendMessage(created.id, '你好')).rejects.toThrow(/ENOENT/);

    // 磁盘上必须是终态：不能停在 starting，否则重启后被当成「跑一半被打断」
    expect(loadOk(new CodexSessionStore({ filePath: storePath })).find((s) => s.id === created.id))
      .toMatchObject({ status: 'failed', runState: 'never_started' });

    // 重启后状态就是 failed（不是 idle），手机端能看出这一轮没跑起来
    const restarted = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    const statuses = new Map(
      (await restarted.listSessions()).map((session) => [session.id, session.status]),
    );
    expect(statuses.get(created.id)).toBe('failed');
  });

  it('数组里单条记录损坏时整份隔离，不静默丢弃那一条', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const dir = makeDir('nienie-store-');
    const storePath = join(dir, 'codex-sessions.json');
    const original = JSON.stringify({
      version: 1,
      sessions: [
        { id: 'codex_ses_ok', title: '正常', projectPath: PROJECT, status: 'idle', createdAt: 'x', updatedAt: 'y' },
        { id: 'codex_ses_broken', title: '缺字段' },
      ],
    });
    writeFileSync(storePath, original, 'utf8');

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    // 坏的那条不能「消失」——整份被隔离，原文件完整保留
    await expect(adapter.listSessions()).resolves.toEqual([]);
    const backup = readdirSync(dir).find((name) => name.includes('.corrupt.'));
    expect(backup).toBeDefined();
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe(original);
  });

  it('starting 落盘失败时拒绝 spawn（安全边界不能靠尽力而为）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const dir = makeDir('nienie-store-');
    const storePath = join(dir, 'codex-sessions.json');
    let spawnCount = 0;

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => {
        spawnCount += 1;
        return createFakeProcess('th_should_not_happen');
      },
    });
    const created = await adapter.createSession({ title: '锁被占用', projectPath: PROJECT });

    // 另一个活进程正持锁 → 落盘必失败
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );

    await expect(adapter.sendMessage(created.id, '你好')).rejects.toThrow(/持久化失败/);
    expect(spawnCount).toBe(0);
    // 内存里这一轮也该是 failed，不能停在「发送中」
    const session = await adapter.loadSession(created.id);
    expect(session.status).toBe('failed');
  });

  it('隔离失败时也不覆盖原文件，并明确写进诊断', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const dir = makeDir('nienie-store-');
    const storePath = join(dir, 'codex-sessions.json');
    const futureContent = JSON.stringify({ version: 99, sessions: [] });
    writeFileSync(storePath, futureContent, 'utf8');

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });

    // 目录只读 → rename 隔离失败 → save 必须 fail-closed
    chmodSync(dir, 0o500);
    try {
      await adapter.createSession({ title: '隔离失败', projectPath: PROJECT });
      expect(readFileSync(storePath, 'utf8')).toBe(futureContent);
      expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toMatch(
        /quarantine FAILED|save failed/,
      );
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('没有 sessionStorePath 时行为不变（不落盘、也不读历史文件）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const adapter = new CodexAdapter({ codexHome, defaultProjectPath: PROJECT });

    const created = await adapter.createSession({ title: '纯内存会话', projectPath: PROJECT });
    const sessions = await adapter.listSessions();

    expect(sessions.map((session) => session.id)).toEqual([created.id]);
  });
});
