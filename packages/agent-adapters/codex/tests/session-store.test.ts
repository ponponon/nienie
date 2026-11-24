import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** 当前磁盘修订号 + 生成代（身份操作的 CAS 基准；`readBinding` 三态里只有 ok 才有）。 */
function at(
  store: CodexSessionStore,
  id: string,
): { revision: number; epoch?: string | undefined } {
  const read = store.readBinding(id);
  if (read.status !== 'ok') throw new Error(`readBinding(${id}) -> ${read.status}`);
  return { revision: read.binding.revision, epoch: read.binding.epoch };
}

/** `readBinding` 三态里取出 ok 的权威绑定。 */
function readOk(store: CodexSessionStore, id: string) {
  const read = store.readBinding(id);
  if (read.status !== 'ok') throw new Error(`readBinding(${id}) -> ${read.status}`);
  return read.binding;
}

/** 模拟「一个还活着的 Bridge」在跑：归属进程就是本进程。 */
const OWNER = `${process.pid}@${hostname()}`;
/** 模拟「上一个实例已经不在了」：跨主机无法验证存活，按没人跑处理。 */
const DEAD_OWNER = `1@other-host.example`;

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

    const result = new CodexSessionStore({ filePath }).quarantineIfUnusable();

    expect(result.status).toBe('quarantined');
    if (result.status !== 'quarantined') return;
    expect(result.reason).toBe('unsupported');
    expect(existsSync(filePath)).toBe(false);
    // 备份文件名要能看出原因，方便用户手工找回
    expect(result.backupPath).toContain('.unsupported.');
    expect(result.backupPath.endsWith('.bak')).toBe(true);
    expect(readFileSync(result.backupPath, 'utf8')).toBe(original);
  });

  it('隔离前在锁内重读：文件已被别的实例修好就不再隔离', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    // 模拟：本实例先读到 version 99（下面的 load），随后另一个实例把它改成可用的新文件
    writeFileSync(filePath, JSON.stringify({ version: 99, sessions: [] }), 'utf8');
    expect(store.load().status).toBe('unsupported');

    const repaired = [
      {
        id: 'codex_ses_b',
        threadId: 'th_b',
        title: '另一个实例写好的会话',
        projectPath: PROJECT,
        status: 'idle',
        createdAt: '2026-11-23T00:00:00.000Z',
        updatedAt: '2026-11-23T00:01:00.000Z',
      },
    ];
    writeFileSync(filePath, JSON.stringify({ version: 1, sessions: repaired }), 'utf8');

    const result = store.quarantineIfUnusable();

    // 关键：采用最新内容，而不是拿锁外的旧结论把刚写好的文件挪进备份
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.sessions.map((session) => session.id)).toEqual(['codex_ses_b']);
    expect(existsSync(filePath)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith('.bak'))).toEqual([]);
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

  it('threadMissing 是粘性标记：旧快照的 undefined 抹不掉它', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_lost',
        threadId: 'th_gone',
        status: 'idle',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ]);
    // 失效标记只能由显式操作写入（save 不接受内存里的 true）
    expect(store.markThreadMissing('codex_ses_lost', 'th_gone', at(store, 'codex_ses_lost')).outcome).toBe('updated');
    // 另一个实例手里是「还不知道线程失效」的旧快照，时间戳更新
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_lost',
        threadId: 'th_gone',
        status: 'running',
        updatedAt: '2026-11-23T00:05:00.000Z',
      },
    ]);

    const [session] = loadOk(store);
    // status 属于执行状态，普通 save 不写（只有 setStatus/finishRun 改）：旧快照的 running 不落地
    expect(session).toMatchObject({ threadId: 'th_gone', threadMissing: true, status: 'idle' });
  });

  it('save 不接受内存里的 threadMissing=true（否则旧快照能把活线程判死）', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([{ ...STORE_BASE, id: 'codex_ses_alive', threadId: 'th_alive', status: 'idle' }]);
    // 旧快照带着「旧线程失效」的事实，但磁盘上已经是新线程：标记不能被贴过来
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_alive',
        threadId: 'th_old_dead',
        threadMissing: true,
        status: 'running',
        updatedAt: '2026-11-23T09:00:00.000Z',
      },
    ]);

    // 身份保住（th_alive 不被 th_old_dead 顶掉），执行状态同样不许普通 save 改写
    expect(loadOk(store)[0]).toMatchObject({ threadId: 'th_alive', status: 'idle' });
    expect(loadOk(store)[0]?.threadMissing).toBeUndefined();
  });

  it('bindThreadId 之后，旧快照的 threadMissing=true 不会复活', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([{ ...STORE_BASE, id: 'codex_ses_revive', threadId: 'th_old', status: 'idle' }]);
    store.markThreadMissing('codex_ses_revive', 'th_old', at(store, 'codex_ses_revive'));
    store.bindThreadId('codex_ses_revive', 'th_new', at(store, 'codex_ses_revive'));
    // B 手里的旧快照：th_old + threadMissing=true，且 updatedAt 更晚
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_revive',
        threadId: 'th_old',
        threadMissing: true,
        status: 'idle',
        updatedAt: '2026-11-23T09:00:00.000Z',
      },
    ]);
    // 旧快照若还要显式标记失效，也不许贴到新线程上（身份不符）
    expect(store.markThreadMissing('codex_ses_revive', 'th_old', at(store, 'codex_ses_revive')).outcome).toBe('mismatch');

    expect(loadOk(store)[0]).toMatchObject({ threadId: 'th_new' });
    expect(loadOk(store)[0]?.threadMissing).toBeUndefined();
  });

  it('confirmThreadPresent 之后，旧快照的 threadMissing=true 不会复活', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([{ ...STORE_BASE, id: 'codex_ses_sync', threadId: 'th_sync', status: 'idle' }]);
    store.markThreadMissing('codex_ses_sync', 'th_sync', at(store, 'codex_ses_sync'));
    expect(store.confirmThreadPresent('codex_ses_sync', 'th_sync', at(store, 'codex_ses_sync')).outcome).toBe('updated');
    // 另一个实例的旧快照仍然带着 true，且 updatedAt 更晚
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_sync',
        threadId: 'th_sync',
        threadMissing: true,
        status: 'running',
        updatedAt: '2026-11-23T09:00:00.000Z',
      },
    ]);

    expect(loadOk(store)[0]?.threadMissing).toBeUndefined();
    // 旧快照里的 status 也不落地（执行状态只走 setStatus/finishRun）
    expect(loadOk(store)[0]?.status).toBe('idle');
  });

  it('普通 save 不换绑：换了 threadId 的旧快照也改不动磁盘上的身份', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_rebind',
        threadId: 'th_gone',
        status: 'idle',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ]);
    store.markThreadMissing('codex_ses_rebind', 'th_gone', at(store, 'codex_ses_rebind'));
    // 直接 save 一个「不同 threadId」的快照：不做隐式 rebind，身份与标记都不动
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_rebind',
        threadId: 'th_new',
        runState: 'started',
        status: 'running',
        updatedAt: '2026-11-23T00:05:00.000Z',
      },
    ]);

    expect(loadOk(store)[0]).toMatchObject({
      threadId: 'th_gone',
      threadMissing: true,
      status: 'idle', // 执行状态同样不许普通 save 改写（只有 setStatus/finishRun 改）
    });
  });

  it('显式 bindThreadId 才换绑并解除 threadMissing', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_rebind',
        threadId: 'th_gone',
        threadMissing: true,
        status: 'idle',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ]);

    expect(store.bindThreadId('codex_ses_rebind', 'th_new', at(store, 'codex_ses_rebind')).outcome).toBe('updated');

    const sessions = loadOk(store);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.threadId).toBe('th_new');
    expect(sessions[0]?.threadMissing).toBeUndefined();
  });

  it('bindThreadId 之后，另一个实例的旧快照也没法把身份换回去', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    // 两个实例各自持有同一会话的旧快照
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_race',
        threadId: 'th_old',
        status: 'idle',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ]);
    // A 换到新线程
    store.bindThreadId('codex_ses_race', 'th_new', at(store, 'codex_ses_race'));
    // B 的旧快照（th_old）后写，且 updatedAt 更晚 —— 不能把 th_new 改回 th_old
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_race',
        threadId: 'th_old',
        status: 'idle',
        updatedAt: '2026-11-23T09:00:00.000Z',
      },
    ]);

    expect(loadOk(store)[0]).toMatchObject({
      threadId: 'th_new',
      updatedAt: '2026-11-23T09:00:00.000Z',
    });
  });

  it('save 不得补空 threadId，也不得导入修订号与执行标识（身份/执行只走显式操作）', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    // 磁盘上还没有 threadId 的既有记录：save 不许把内存里的 threadId「补」上去——
    // 补空等于换了身份却没推进修订号，一个拿着旧修订号的过期执行照样能通过 CAS（绕过 CAS）
    store.save([{ ...STORE_BASE, id: 'codex_ses_fill', status: 'idle' }]);
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_fill',
        threadId: 'th_first',
        runState: 'started',
        status: 'running',
        updatedAt: '2026-11-23T00:15:00.000Z',
      },
    ]);
    expect(loadOk(store)[0]?.threadId).toBeUndefined();
    expect(readOk(store, 'codex_ses_fill').revision).toBe(0);

    // 身份只能由显式操作写入
    expect(store.bindThreadId('codex_ses_fill', 'th_first', at(store, 'codex_ses_fill')).outcome).toBe(
      'updated',
    );
    expect(readOk(store, 'codex_ses_fill').revision).toBe(1);

    // 一轮执行开跑后，普通 save 也不许改写执行状态/标识、身份和修订号
    const begun = store.beginRun('codex_ses_fill', at(store, 'codex_ses_fill'), '2026-11-23T00:20:00.000Z', OWNER);
    expect(begun.outcome).toBe('started');
    if (begun.outcome !== 'started') return;
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_fill',
        threadId: 'th_other',
        threadMissing: true,
        bindingRevision: 99,
        status: 'failed',
        runState: 'never_started',
        runAttempt: 'fake-attempt',
        runOwner: '9@other-host',
        updatedAt: '2026-11-23T00:25:00.000Z',
      },
    ]);
    expect(loadOk(store)[0]).toMatchObject({
      threadId: 'th_first',
      status: 'idle',
      runState: 'starting',
      runAttempt: begun.attempt,
      runOwner: OWNER,
    });
    expect(loadOk(store)[0]?.threadMissing).toBeUndefined();
    expect(readOk(store, 'codex_ses_fill').revision).toBe(1);
  });

  it('confirmThreadPresent 只对同一个 threadId 生效', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_resync',
        threadId: 'th_sync',
        status: 'idle',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ]);
    store.markThreadMissing('codex_ses_resync', 'th_sync', at(store, 'codex_ses_resync'));

    // 别的实例拿着另一个 id 说「它存在」——不构成恢复证据
    expect(store.confirmThreadPresent('codex_ses_resync', 'th_other', at(store, 'codex_ses_resync')).outcome).toBe('mismatch');
    expect(loadOk(store)[0]?.threadMissing).toBe(true);

    // 同一个 id 重新出现才解除
    expect(store.confirmThreadPresent('codex_ses_resync', 'th_sync', at(store, 'codex_ses_resync')).outcome).toBe('updated');
    expect(loadOk(store)[0]?.threadMissing).toBeUndefined();
    expect(loadOk(store)[0]?.threadId).toBe('th_sync');
  });

  it('显式绑定操作对读不动的文件同样 fail-closed', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    writeFileSync(filePath, '{ broken', 'utf8');
    const store = new CodexSessionStore({ filePath });

    expect(() => store.bindThreadId('codex_ses_any', 'th_new', { revision: 0 })).toThrow(/corrupt/);
    expect(() => store.confirmThreadPresent('codex_ses_any', 'th_new', { revision: 0 })).toThrow(
      /corrupt/,
    );
    expect(() => store.markThreadMissing('codex_ses_any', 'th_new', { revision: 0 })).toThrow(
      /corrupt/,
    );
    expect(readFileSync(filePath, 'utf8')).toBe('{ broken');
  });

  it('记录不在盘上时显式绑定返回 not-found，不凭空造记录', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    expect(store.bindThreadId('codex_ses_absent', 'th_new', { revision: 0 }).outcome).toBe(
      'not-found',
    );
    expect(store.confirmThreadPresent('codex_ses_absent', 'th_new', { revision: 0 }).outcome).toBe(
      'not-found',
    );
    expect(store.markThreadMissing('codex_ses_absent', 'th_new', { revision: 0 }).outcome).toBe(
      'not-found',
    );
    // 没写任何东西：文件仍然不存在
    expect(existsSync(filePath)).toBe(false);
  });

  it('显式操作区分「本来就不用改」和「没找到记录」', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_same', threadId: 'th_same', status: 'idle' }]);

    // 换绑到同一个 id 且没有标记 → 无需改动，但记录是找得到的
    expect(store.bindThreadId('codex_ses_same', 'th_same', at(store, 'codex_ses_same')).outcome).toBe('unchanged');
    // 本来就没有标记 → 恢复也是「无需改动」
    expect(store.confirmThreadPresent('codex_ses_same', 'th_same', at(store, 'codex_ses_same')).outcome).toBe('unchanged');
    // 置位两次：第二次是「无需改动」
    expect(store.markThreadMissing('codex_ses_same', 'th_same', at(store, 'codex_ses_same')).outcome).toBe('updated');
    expect(store.markThreadMissing('codex_ses_same', 'th_same', at(store, 'codex_ses_same')).outcome).toBe('unchanged');
  });

  it('readBinding 三态：ok 带权威绑定，absent 与 unreadable 严格区分', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([{ ...STORE_BASE, id: 'codex_ses_read', threadId: 'th_read', status: 'idle' }]);
    const first = store.readBinding('codex_ses_read');
    expect(first).toEqual({
      status: 'ok',
      binding: { threadId: 'th_read', revision: 0, epoch: expect.any(String) },
    });
    // 生成代与记录同生共死：显式操作推进修订号也不会换代
    const epoch = first.status === 'ok' ? first.binding.epoch : undefined;

    store.markThreadMissing('codex_ses_read', 'th_read', at(store, 'codex_ses_read'));
    expect(store.readBinding('codex_ses_read')).toEqual({
      status: 'ok',
      binding: { threadId: 'th_read', threadMissing: true, revision: 1, epoch },
    });

    // 记录不在盘上 → absent（可以从零开始）
    expect(store.readBinding('codex_ses_other')).toEqual({ status: 'absent' });

    // 读不动 → unreadable：绝不与 absent 混同——混同就会被决策当「从零开始」降级成无 CAS
    writeFileSync(filePath, '{ broken', 'utf8');
    expect(store.readBinding('codex_ses_read')).toEqual({ status: 'unreadable' });
  });

  it('beginNewThreadFromMissing 一次原子写完成「标记 + starting」', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_begin',
        threadId: 'th_old',
        status: 'idle',
        runState: 'started',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ]);

    expect(store.beginNewThreadFromMissing('codex_ses_begin', 'th_old', at(store, 'codex_ses_begin'), '2026-11-23T01:00:00.000Z', OWNER).outcome)
      .toBe('started');
    expect(loadOk(store)[0]).toMatchObject({
      threadId: 'th_old', // 最后已知身份保留
      threadMissing: true,
      runState: 'starting',
      updatedAt: '2026-11-23T01:00:00.000Z',
    });
    // 再来一轮：标记不用重复置位（修订号不推进），但执行照常接管——新 attempt 顶掉旧的，
    // 收尾 fencing 以新 attempt 为准（没有执行租约时，新的一轮总是接管旧的 attempt）
    const again = store.beginNewThreadFromMissing(
      'codex_ses_begin',
      'th_old',
      at(store, 'codex_ses_begin'),
      '2026-11-23T02:00:00.000Z',
      OWNER,
    );
    expect(again.outcome).toBe('started');
    if (again.outcome === 'started') {
      expect(again.revision).toBe(1); // threadMissing 已置位 → 不因重复标记而推进
      expect(loadOk(store)[0]?.runAttempt).toBe(again.attempt);
    }
  });

  it('标记与 starting 之间被别人清掉标记，也不会留下「starting 且无标记」', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([
      {
        ...STORE_BASE,
        id: 'codex_ses_race2',
        threadId: 'th_old',
        status: 'idle',
        runState: 'started',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ]);

    // A 标记失效 → B（以为线程回来了）清掉标记 → A 才做「开新线程 + starting」那次原子写。
    // 因为这次写把标记和 starting 放在同一个临界区，中间没有窗口，最终状态一定是对的。
    store.markThreadMissing('codex_ses_race2', 'th_old', at(store, 'codex_ses_race2'));
    store.confirmThreadPresent('codex_ses_race2', 'th_old', at(store, 'codex_ses_race2'));
    store.beginNewThreadFromMissing('codex_ses_race2', 'th_old', at(store, 'codex_ses_race2'), '2026-11-23T01:00:00.000Z', OWNER);

    // 这两个字段必须同时在场，否则重启会把「跑一半被打断」误判成 idle
    expect(loadOk(store)[0]).toMatchObject({ threadMissing: true, runState: 'starting' });
  });

  it('别人已经换绑时 beginNewThreadFromMissing 拒绝写入（身份过期）', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_stale', threadId: 'th_old', status: 'idle' }]);
    store.bindThreadId('codex_ses_stale', 'th_new', at(store, 'codex_ses_stale'));

    expect(store.beginNewThreadFromMissing('codex_ses_stale', 'th_old', at(store, 'codex_ses_stale'), '2026-11-23T01:00:00.000Z', OWNER).outcome)
      .toBe('identity-mismatch');
    expect(loadOk(store)[0]).toMatchObject({ threadId: 'th_new', status: 'idle' });
    expect(loadOk(store)[0]?.threadMissing).toBeUndefined();
    // 拒绝写入：runState 停在新建时的 never_started，绝不会被写成 starting
    expect(loadOk(store)[0]?.runState).toBe('never_started');
  });

  it('记录不在盘上时 beginNewThreadFromMissing 返回 not-found', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_only', threadId: 'th_x', status: 'idle' }]);

    expect(
      store.beginNewThreadFromMissing(
        'codex_ses_absent',
        'th_x',
        { revision: 0 },
        '2026-11-23T01:00:00.000Z',
        OWNER,
      ).outcome,
    ).toBe('not-found');
  });

  it('bindThreadId 的 CAS：修订号对不上就拒绝换绑', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_cas', threadId: 'th_a', status: 'idle' }]);

    // 首版记录没有修订号，按 0 处理
    expect(readOk(store, 'codex_ses_cas').revision).toBe(0);
    expect(store.bindThreadId('codex_ses_cas', 'th_b', at(store, 'codex_ses_cas')).outcome).toBe('updated');
    expect(readOk(store, 'codex_ses_cas').revision).toBe(1);
    // 一次过期的执行还拿着修订号 0 来换绑 → 拒绝，磁盘保持 th_b
    expect(store.bindThreadId('codex_ses_cas', 'th_c', { revision: 0 }).outcome).toBe('mismatch');
    expect(loadOk(store)[0]?.threadId).toBe('th_b');
    // 带上当前修订号才允许换绑
    expect(store.bindThreadId('codex_ses_cas', 'th_d', at(store, 'codex_ses_cas')).outcome).toBe('updated');
    expect(loadOk(store)[0]?.threadId).toBe('th_d');
  });

  it('id 回到旧样子时，只有修订号能识别出「这期间已经被改过」', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_aba', threadId: 'th_old', status: 'idle' }]);
    // A 这一轮开始时认识的绑定：th_old @ revision 0
    const observed = readOk(store, 'codex_ses_aba');

    // 线程 missing → 恢复 → 又 missing：三次显式操作把修订号推到 3，id 却回到了 th_old
    expect(store.markThreadMissing('codex_ses_aba', 'th_old', at(store, 'codex_ses_aba')).outcome).toBe('updated');
    expect(store.confirmThreadPresent('codex_ses_aba', 'th_old', at(store, 'codex_ses_aba')).outcome).toBe('updated');
    expect(store.markThreadMissing('codex_ses_aba', 'th_old', at(store, 'codex_ses_aba')).outcome).toBe('updated');
    const now = readOk(store, 'codex_ses_aba');
    expect(now.threadId).toBe(observed.threadId);
    expect(now.revision).toBe(observed.revision + 3);

    // 只比 id 的话这次换绑会被放行（id 一模一样），比修订号才能认出这是过期的认识
    expect(
      store.bindThreadId('codex_ses_aba', 'th_new', { revision: observed.revision }).outcome,
    ).toBe('mismatch');
    expect(loadOk(store)[0]?.threadId).toBe('th_old');
    // 用当前修订号才允许换绑
    expect(store.bindThreadId('codex_ses_aba', 'th_new', at(store, 'codex_ses_aba')).outcome).toBe(
      'updated',
    );
    expect(loadOk(store)[0]?.threadId).toBe('th_new');
    expect(loadOk(store)[0]?.threadMissing).toBeUndefined();
  });

  it('beginNewThreadFromMissing 也认修订号：id 相同但修订号过期时不许开新线程', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_rev', threadId: 'th_old', status: 'idle' }]);

    // 别的实例先判失效、又确认恢复：id 没变，修订号 +2
    store.markThreadMissing('codex_ses_rev', 'th_old', at(store, 'codex_ses_rev'));
    store.confirmThreadPresent('codex_ses_rev', 'th_old', at(store, 'codex_ses_rev'));

    expect(
      store.beginNewThreadFromMissing(
        'codex_ses_rev',
        'th_old',
        { revision: 0 },
        '2026-11-23T01:00:00.000Z',
        OWNER,
      ).outcome,
    ).toBe('stale-revision');
    expect(loadOk(store)[0]?.threadMissing).toBeUndefined();
    // 拒绝写入：runState 停在新建时的 never_started，绝不会被写成 starting
    expect(loadOk(store)[0]?.runState).toBe('never_started');

    // 拿对修订号才允许这次原子转换
    expect(
      store.beginNewThreadFromMissing(
        'codex_ses_rev',
        'th_old',
        at(store, 'codex_ses_rev'),
        '2026-11-23T01:00:00.000Z',
        OWNER,
      ).outcome,
    ).toBe('started');
    expect(loadOk(store)[0]).toMatchObject({ threadMissing: true, runState: 'starting' });
  });

  it('普通 save 不写修订号：磁盘上的修订号只会被显式操作推进', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_rev2', threadId: 'th_a', status: 'idle' }]);
    store.bindThreadId('codex_ses_rev2', 'th_b', at(store, 'codex_ses_rev2')); // revision 0 → 1

    // 另一个实例的旧快照带着修订号 99：save 必须保留磁盘的 1，否则一次脏写就能让所有 CAS 失准
    store.save([
      { ...STORE_BASE, id: 'codex_ses_rev2', threadId: 'th_b', status: 'running', bindingRevision: 99 },
    ]);
    expect(readOk(store, 'codex_ses_rev2').revision).toBe(1);

    // 既有记录上 save 也不许「补」修订号——补了等于绕过 CAS 偷换基准
    store.save([{ ...STORE_BASE, id: 'codex_ses_rev3', threadId: 'th_a', status: 'idle' }]);
    store.save([{ ...STORE_BASE, id: 'codex_ses_rev3', status: 'running', bindingRevision: 4 }]);
    expect(readOk(store, 'codex_ses_rev3').revision).toBe(0);
  });

  it('首版记录没有 bindingRevision 时按 0 迁移，CAS 立即可用', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    // 手写首版格式：没有 bindingRevision / runState / runAttempt / runOwner
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: 'codex_ses_legacy',
            threadId: 'th_legacy',
            title: '首版会话',
            projectPath: PROJECT,
            status: 'idle',
            createdAt: '2026-11-23T00:00:00.000Z',
            updatedAt: '2026-11-23T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
    const store = new CodexSessionStore({ filePath });

    expect(readOk(store, 'codex_ses_legacy').revision).toBe(0);
    // 迁移后的 0 就是合法的 CAS 基准：显式操作立刻可用
    expect(store.bindThreadId('codex_ses_legacy', 'th_new', { revision: 0 }).outcome).toBe('updated');
    expect(readOk(store, 'codex_ses_legacy').revision).toBe(1);
  });

  it('旧 attempt 不能覆盖新一轮的执行状态（fencing）', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_fence', status: 'idle' }]);

    const first = store.beginRun(
      'codex_ses_fence',
      at(store, 'codex_ses_fence'),
      '2026-11-23T01:00:00.000Z',
      OWNER,
    );
    expect(first.outcome).toBe('started');
    if (first.outcome !== 'started') return;
    // 新一轮接管（没有执行租约时，新的一轮总是接管旧的 attempt）
    const second = store.beginRun(
      'codex_ses_fence',
      at(store, 'codex_ses_fence'),
      '2026-11-23T02:00:00.000Z',
      OWNER,
    );
    expect(second.outcome).toBe('started');
    if (second.outcome !== 'started') return;
    expect(second.attempt).not.toBe(first.attempt);

    // 旧 attempt 迟到的收尾/换绑一律拒绝
    expect(
      store.finishRun(
        'codex_ses_fence',
        { attempt: first.attempt },
        { status: 'failed', runState: 'never_started', updatedAt: '2026-11-23T03:00:00.000Z' },
      ),
    ).toBe('stale-attempt');
    expect(
      store.commitThreadStarted(
        'codex_ses_fence',
        { attempt: first.attempt, revision: 0 },
        'th_late',
        '2026-11-23T03:00:00.000Z',
      ).outcome,
    ).toBe('stale-attempt');
    expect(loadOk(store)[0]).toMatchObject({ runState: 'starting', status: 'idle' });
    expect(loadOk(store)[0]?.threadId).toBeUndefined();

    // 新 attempt 的收尾正常落盘
    expect(
      store.finishRun(
        'codex_ses_fence',
        { attempt: second.attempt },
        { status: 'idle', runState: 'started', updatedAt: '2026-11-23T04:00:00.000Z' },
      ),
    ).toBe('finished');
    expect(loadOk(store)[0]).toMatchObject({ runState: 'started', status: 'idle' });
  });

  it('记录被删后重建：旧的修订号 + 生成代都对不上，过期期望值不得接管新记录', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_reborn', threadId: 'th_old', status: 'idle' }]);
    // A 这一轮开始时认识的绑定：th_old @ revision 0（含生成代）
    const observed = readOk(store, 'codex_ses_reborn');
    expect(observed.epoch).toEqual(expect.any(String));

    // 记录被删（整份重写/截断）后又重建：修订号回到 0，生成代是新的
    writeFileSync(filePath, JSON.stringify({ version: 1, sessions: [] }), 'utf8');
    store.save([{ ...STORE_BASE, id: 'codex_ses_reborn', threadId: 'th_new', status: 'idle' }]);
    const reborn = readOk(store, 'codex_ses_reborn');
    expect(reborn.revision).toBe(0); // 修订号回到了旧值——纯修订号 CAS 会在这里被骗过
    expect(reborn.epoch).not.toBe(observed.epoch); // 但生成代换了：这才是识别新旧记录的依据

    // 旧纪元的期望值（对得上修订号、对不上生成代）一律拒绝
    expect(
      store.beginRun(
        'codex_ses_reborn',
        { revision: observed.revision, epoch: observed.epoch },
        '2026-11-23T01:00:00.000Z',
        OWNER,
      ).outcome,
    ).toBe('identity-mismatch');
    expect(
      store.bindThreadId('codex_ses_reborn', 'th_hijack', {
        revision: observed.revision,
        epoch: observed.epoch,
      }).outcome,
    ).toBe('mismatch');
    // 只带修订号的旧式期望值同样不通过：不给「无生成代」留后门
    expect(
      store.beginRun('codex_ses_reborn', { revision: 0 }, '2026-11-23T01:00:00.000Z', OWNER)
        .outcome,
    ).toBe('identity-mismatch');
    // 新纪元的期望值才被接受
    expect(
      store.beginRun(
        'codex_ses_reborn',
        at(store, 'codex_ses_reborn'),
        '2026-11-23T01:00:00.000Z',
        OWNER,
      ).outcome,
    ).toBe('started');
  });

  it('写锁被活进程持有时拒绝写盘（不无锁覆盖），成功写完不留锁文件', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    store.save([{ ...STORE_BASE, id: 'codex_ses_keep', title: '原有会话', status: 'idle' }]);
    // 正常路径写完必须清掉锁，否则下次启动会以为有人一直持锁
    expect(existsSync(`${filePath}.lock`)).toBe(false);

    // 另一个「活着的进程」（用当前 pid 冒充）正持锁
    writeFileSync(
      `${filePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    // 错误信息要能让人照着处理：路径 + 持有者 PID + 它还在运行
    expect(() =>
      store.save([{ ...STORE_BASE, id: 'codex_ses_new', title: '抢不到锁', status: 'idle' }]),
    ).toThrow(new RegExp(`占用.*PID ${process.pid} 仍在运行`));
    // 拒绝而不是覆盖：原数据必须完好
    expect(loadOk(store).map((session) => session.id)).toEqual(['codex_ses_keep']);
    // 也不许「顺手清理」别人的锁
    expect(existsSync(`${filePath}.lock`)).toBe(true);
  });

  it('持有进程已消失的锁也不自动删除，只提示人工确认', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });
    store.save([{ ...STORE_BASE, id: 'codex_ses_keep', title: '原有', status: 'idle' }]);

    // 崩溃残留：持有者 PID 不存在（自动回收曾在这里被 review 指出有 ABA，故改为不回收）
    writeFileSync(
      `${filePath}.lock`,
      JSON.stringify({ pid: 999999, at: Date.now(), token: 'dead' }),
      'utf8',
    );

    expect(() =>
      store.save([{ ...STORE_BASE, id: 'codex_ses_new', title: '新', status: 'idle' }]),
    ).toThrow(/崩溃残留.*删除该文件后重试/);
    // 关键：没有自动删除（宁可暂时不可写，也不冒互斥失效的风险）
    expect(existsSync(`${filePath}.lock`)).toBe(true);
    expect(loadOk(store).map((session) => session.id)).toEqual(['codex_ses_keep']);

    // 人工删除后即可恢复
    rmSync(`${filePath}.lock`);
    store.save([{ ...STORE_BASE, id: 'codex_ses_new', title: '新', status: 'idle' }]);
    expect(loadOk(store).map((session) => session.id).sort()).toEqual([
      'codex_ses_keep',
      'codex_ses_new',
    ]);
  });

  it('锁内容不可读时也拒绝写入，不当场删', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    writeFileSync(`${filePath}.lock`, '', 'utf8');

    expect(() =>
      new CodexSessionStore({ filePath }).save([
        { ...STORE_BASE, id: 'codex_ses_x', title: 'x', status: 'idle' },
      ]),
    ).toThrow(/锁内容不可读/);
    expect(existsSync(`${filePath}.lock`)).toBe(true);
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
      status: 'idle', // 执行状态不归 save 管：旧快照的 running 不落地
      runState: 'started',
      updatedAt: '2026-11-23T00:05:00.000Z',
    });
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

  it('spawn 后崩溃（停在 starting）恢复为 failed，不伪装成空会话', async () => {
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
      // 同样的崩溃窗口，但这一轮是 resume 老线程（threadId 本来就有）。
      // 不能因为「threadId 非空」就当成没跑过：resume 起来的进程可能已经在 Codex 侧执行了，
      // 恢复成 idle 会让用户以为消息没发出去，再发一次就是重复执行。
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
    expect(statuses.get('codex_ses_resumed')).toBe('failed');
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

  it('首次加载失败不是终态：退避后会自动重试并恢复会话', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const dir = makeDir('nienie-store-');
    const storePath = join(dir, 'codex-sessions.json');
    const original = JSON.stringify({ version: 99, sessions: [] });
    writeFileSync(storePath, original, 'utf8');
    // 另一个实例正持锁 → 这一轮连隔离都做不了（quarantineIfUnusable 抢不到锁）
    const lockPath = `${storePath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }), 'utf8');

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });

    vi.useFakeTimers();
    try {
      // 第 1 次：隔离被跳过，绝不能把「已加载」写死
      await adapter.listSessions();
      expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toMatch(/quarantine skipped/);
      expect(await adapter.listSessions()).toEqual([]);

      // 第 2 次：**锁仍然在**，只是过了退避窗口。仍然不能加载成功——
      // 否则就是把「重试了一次」误当成「加载完成」，会话照样丢。
      vi.advanceTimersByTime(1_100);
      expect(await adapter.listSessions()).toEqual([]);

      // 第 3 次：锁释放 + 文件被修好，再等一个退避周期（失败两次后已涨到 2s）
      rmSync(lockPath);
      writeFileSync(
        storePath,
        JSON.stringify({
          version: 1,
          sessions: [
            {
              id: 'codex_ses_late',
              title: '恢复出来的会话',
              projectPath: PROJECT,
              status: 'idle',
              createdAt: '2026-11-23T00:00:00.000Z',
              updatedAt: '2026-11-23T00:01:00.000Z',
            },
          ],
        }),
        'utf8',
      );
      vi.advanceTimersByTime(2_100);

      const sessions = await adapter.listSessions();
      expect(sessions.map((session) => session.id)).toEqual(['codex_ses_late']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('锁元数据非法时降级为「内容不可读」，不会因为格式化时间抛错', () => {
    const dir = makeDir('nienie-store-');
    const filePath = join(dir, 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath });

    const cases = [
      '{"pid":123,"at":1e999,"token":"x"}', // JSON.parse → Infinity，new Date(Infinity).toISOString() 会抛
      '{"pid":"123","at":1,"token":"x"}', // pid 是字符串
      '{"pid":-1,"at":1,"token":"x"}', // 非正
      '{"pid":1.5,"at":1,"token":"x"}', // 非整数
      '{"pid":123,"at":1,"token":""}', // token 空
    ];
    for (const content of cases) {
      writeFileSync(`${filePath}.lock`, content, 'utf8');
      // 关键：抛出的是「锁被占用」的正常信息，而不是 RangeError
      expect(() =>
        store.save([{ ...STORE_BASE, id: 'codex_ses_x', title: 'x', status: 'idle' }]),
      ).toThrow(/锁内容不可读/);
      expect(existsSync(`${filePath}.lock`)).toBe(true);
    }
  });

  it('落盘文件权限是 0600（会话标题与项目路径属于本地隐私）', () => {
    const filePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath }).save([
      { ...STORE_BASE, id: 'codex_ses_perm', title: '权限', status: 'idle' },
    ]);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('非 codex_ses_* 的记录不会被当成 Nienie 会话（防止被塞入任意 threadId）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      {
        ...STORE_BASE,
        id: 'codex_ses_own',
        title: '自己的会话',
        status: 'idle',
        threadId: 'th_own',
      },
      // 伪造记录：id 用别人的 threadId 形式，不能被当成可恢复会话
      { ...STORE_BASE, id: 'th_someone_else', title: '伪造', status: 'idle' },
    ]);

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    expect((await adapter.listSessions()).map((session) => session.id)).toEqual(['codex_ses_own']);
  });

  it('六种状态的重启降级规则', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_starting', title: 's', status: 'starting', threadId: 'th_a', runState: 'starting' },
      { ...STORE_BASE, id: 'codex_ses_running', title: 'r', status: 'running', threadId: 'th_b', runState: 'started' },
      { ...STORE_BASE, id: 'codex_ses_waiting', title: 'w', status: 'waiting', threadId: 'th_c', runState: 'started' },
      { ...STORE_BASE, id: 'codex_ses_completed', title: 'c', status: 'completed', threadId: 'th_d', runState: 'started' },
      { ...STORE_BASE, id: 'codex_ses_failed', title: 'f', status: 'failed', threadId: 'th_e', runState: 'started' },
      { ...STORE_BASE, id: 'codex_ses_cancelled', title: 'x', status: 'cancelled', threadId: 'th_f', runState: 'started' },
    ]);

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    const statuses = new Map(
      (await adapter.listSessions()).map((session) => [session.id, session.status]),
    );

    // 进程都不在了：只是「状态是 running/waiting」的一律降级 idle（runState 已经是 started，
    // 说明 thread.started 落过盘，这一轮的身份是确定的）
    expect(statuses.get('codex_ses_running')).toBe('idle');
    expect(statuses.get('codex_ses_waiting')).toBe('idle');
    // 但 runState 还停在 starting = spawn 发出去了、thread.started 没落盘 = 被打断。
    // 有 threadId 也一样：resume 起来的那一轮可能已经在 Codex 侧跑了，用户的消息不能静默消失。
    expect(statuses.get('codex_ses_starting')).toBe('failed');
    // 终态保留，不能被「降级」洗掉
    expect(statuses.get('codex_ses_completed')).toBe('completed');
    expect(statuses.get('codex_ses_failed')).toBe('failed');
    expect(statuses.get('codex_ses_cancelled')).toBe('cancelled');
  });

  it('没有 sessionStorePath 时行为不变（不落盘、也不读历史文件）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const adapter = new CodexAdapter({ codexHome, defaultProjectPath: PROJECT });

    const created = await adapter.createSession({ title: '纯内存会话', projectPath: PROJECT });
    const sessions = await adapter.listSessions();

    expect(sessions.map((session) => session.id)).toEqual([created.id]);
  });
});
