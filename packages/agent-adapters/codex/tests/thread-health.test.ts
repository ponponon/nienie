import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import { CodexAdapter, CodexSessionStore, type CodexProcessHandle } from '../src/index.js';

const PROJECT = '/workspace/nienie';
const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
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

/** 假 Codex 进程：只吐 thread.started，然后正常退出。 */
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

/** 假 Codex 进程：spawn 成功后再也不吐任何东西（模拟「新线程已起、threadId 还没回来就崩溃」）。 */
function createSilentProcess(): CodexProcessHandle {
  const emitter = new EventEmitter();
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
    onSpawn(listener) {
      emitter.once('spawn', listener);
      emitter.emit('spawn');
    },
  };
}

/** 假 Codex 进程：输出行、运行期报错和退出时机都由测试手动控制。 */
function createManualProcess(): CodexProcessHandle & { finish(code?: number): void; fail(error?: Error): void } {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  return {
    stdout,
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
    onSpawn(listener) {
      emitter.once('spawn', listener);
      emitter.emit('spawn');
    },
    finish(code = 0) {
      stdout.end();
      emitter.emit('exit', code);
    },
    fail(error = new Error('stdio crashed')) {
      emitter.emit('error', error);
    },
  };
}

/** 建一个只有 threads 表的 state 库，用来验证「线程是否还存在」。 */
function seedThreads(codexHome: string, ids: string[]): void {
  const dbPath = join(codexHome, 'state_5.sqlite');
  execFileSync(
    'sqlite3',
    [
      dbPath,
      'CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", cwd TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL DEFAULT "");',
    ],
    { stdio: 'ignore' },
  );
  for (const id of ids) {
    execFileSync(
      'sqlite3',
      [
        dbPath,
        `INSERT OR REPLACE INTO threads VALUES (${sqlText(id)}, 'th', ${sqlText(PROJECT)}, 1700000000, 1700000001, 'cli', 0, 'th');`,
      ],
      { stdio: 'ignore' },
    );
  }
}

const STORE_BASE = {
  title: '手机端任务',
  projectPath: PROJECT,
  status: 'idle' as const,
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:10:00.000Z',
};

/** 当前磁盘修订号 + 生成代（身份操作的 CAS 基准）。 */
function at(
  store: CodexSessionStore,
  id: string,
): { revision: number; epoch?: string | undefined } {
  const read = store.readBinding(id);
  if (read.status !== 'ok') throw new Error(`readBinding(${id}) -> ${read.status}`);
  return { revision: read.binding.revision, epoch: read.binding.epoch };
}

/** 「一个还活着的 Bridge」在跑：归属进程就是本进程。 */
const OWNER = `${process.pid}@${hostname()}`;
/** 「上一个实例已经不在了」：跨主机无法验证存活，按没人跑处理（模拟崩溃现场）。 */
const DEAD_OWNER = '1@other-host.example';

/**
 * 白盒读内存里的身份。
 *
 * 「落盘失败时不许提前推进内存身份」这条保证没有对外可观测面（`AgentSession` 不暴露 threadId），
 * 但它正是「内存与磁盘不许分叉」的落点，所以只能直接看内部记录。
 */
function peekThreadId(adapter: CodexAdapter, sessionId: string): string | undefined {
  const sessions = (
    adapter as unknown as { sessions: Map<string, { threadId?: string }> }
  ).sessions;
  return sessions.get(sessionId)?.threadId;
}

/** 白盒读内存里的失效标记（「决策必须全量同步磁盘事实」的落点）。 */
function peekThreadMissing(adapter: CodexAdapter, sessionId: string): boolean | undefined {
  const sessions = (
    adapter as unknown as { sessions: Map<string, { threadMissing?: boolean }> }
  ).sessions;
  return sessions.get(sessionId)?.threadMissing;
}

/** 白盒读内存里的展示状态（「过期执行的失败不冒充当前 attempt 的失败」的落点）。 */
function peekStatus(adapter: CodexAdapter, sessionId: string): string | undefined {
  const sessions = (adapter as unknown as { sessions: Map<string, { status?: string }> }).sessions;
  return sessions.get(sessionId)?.status;
}

describe('Codex 线程恢复的真实性', () => {
  it('重启后第二轮真的走 exec resume <threadId>（不只是内部状态对）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_persisted']);
    new CodexSessionStore({ filePath: storePath }).save([
      {
        ...STORE_BASE,
        id: 'codex_ses_resume',
        threadId: 'th_persisted',
        runState: 'started',
      },
    ]);

    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args, options) => {
        calls.push({ args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
        return createFakeProcess('th_persisted');
      },
    });

    // 模拟 Bridge 重启后手机端继续发消息
    await adapter.loadSession('codex_ses_resume');
    await adapter.sendMessage('codex_ses_resume', '接着上次的活干');
    await adapter.waitForRun('codex_ses_resume');

    expect(calls[0]).toEqual({
      args: ['exec', 'resume', '--json', '--skip-git-repo-check', 'th_persisted', '接着上次的活干'],
      cwd: PROJECT,
    });
  });

  it('线程已被删除时不拿死 id 去 resume，改为开新线程并留可见提示', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    // state 库里没有 th_gone（用户删了线程 / 换机器 / 库被重置）
    seedThreads(codexHome, ['th_other']);
    new CodexSessionStore({ filePath: storePath }).save([
      {
        ...STORE_BASE,
        id: 'codex_ses_orphan',
        threadId: 'th_gone',
        runState: 'started',
      },
    ]);

    const calls: string[][] = [];
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => {
        calls.push(args);
        return createFakeProcess('th_fresh');
      },
    });

    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.loadSession('codex_ses_orphan');
    await adapter.sendMessage('codex_ses_orphan', '继续');
    await adapter.waitForRun('codex_ses_orphan');

    // 关键：不是 resume，而是新建（否则 Codex 会报线程不存在，用户却以为还能接着聊）
    expect(calls[0]).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      PROJECT,
      '继续',
    ]);
    // 手机端要能看到「上下文断了」
    const notice = events.find(
      (event) => event.type === 'error' && event.payload.code === 'THREAD_LOST',
    );
    expect(notice).toBeDefined();
    expect(String(notice!.payload.message)).toContain('th_gone');
    // 诊断里也要留痕
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain(
      'no longer exists',
    );
    // 新线程被正常绑定：下一轮才会 resume 它
    await adapter.sendMessage('codex_ses_orphan', '第二条');
    await adapter.waitForRun('codex_ses_orphan');
    expect(calls[1]).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      'th_fresh',
      '第二条',
    ]);
  });

  it('state 库查询失败时按「存在」处理（不因为一次抖动判用户上下文死刑）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    // 建一个不是 sqlite 的文件冒充 state 库，让查询必然失败
    execFileSync('sqlite3', [join(codexHome, 'state_5.sqlite'), 'CREATE TABLE t(x);'], {
      stdio: 'ignore',
    });
    execFileSync('sqlite3', [join(codexHome, 'state_5.sqlite'), 'DROP TABLE t;'], {
      stdio: 'ignore',
    });
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_unknown', threadId: 'th_unknown', runState: 'started' },
    ]);

    const calls: string[][] = [];
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => {
        calls.push(args);
        return createFakeProcess('th_unknown');
      },
    });

    await adapter.loadSession('codex_ses_unknown');
    await adapter.sendMessage('codex_ses_unknown', '继续');
    await adapter.waitForRun('codex_ses_unknown');

    // threads 表不存在 → 查询报错 → fail-open，仍然 resume（交给 Codex 自己判断）
    expect(calls[0]?.slice(0, 2)).toEqual(['exec', 'resume']);
  });

  it('确认旧线程不存在后把 threadMissing 落盘（否则死 id 会被合并回来）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_lost', threadId: 'th_gone', runState: 'started' },
    ]);

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => createSilentProcess(),
    });

    await adapter.loadSession('codex_ses_lost');
    await adapter.sendMessage('codex_ses_lost', '继续');

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({
      threadId: 'th_gone', // 最后已知身份保留，便于诊断
      threadMissing: true, // 但明确标记「不许再 resume」
      runState: 'starting',
    });
  });

  it('新线程起来但 threadId 还没回来就崩溃 → 重启恢复成 failed 而不是 idle', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_crash', threadId: 'th_gone', runState: 'started' },
    ]);

    // 第一次运行：检测到旧线程不存在 → 开新线程 → 进程起来了但不吐 thread.started（崩溃）。
    // ownerId 用异主机标识 = 这一轮的进程「已经不在了」，重启判定才有崩溃现场可依
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      ownerId: DEAD_OWNER,
      spawnProcess: () => createSilentProcess(),
    });
    await first.loadSession('codex_ses_crash');
    await first.sendMessage('codex_ses_crash', '继续');

    // 重启：磁盘上是 threadId=th_gone + threadMissing + runState=starting。
    // 不能因为「threadId 非空」就当成没跑过 —— 新线程的身份已经丢了。
    const second = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    const statuses = new Map(
      (await second.listSessions()).map((session) => [session.id, session.status]),
    );
    expect(statuses.get('codex_ses_crash')).toBe('failed');
  });

  it('新线程绑定成功后清掉 threadMissing，并持久化新 threadId', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_rebind', threadId: 'th_gone', runState: 'started' },
    ]);

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => createFakeProcess('th_new'),
    });
    await adapter.loadSession('codex_ses_rebind');
    await adapter.sendMessage('codex_ses_rebind', '继续');
    await adapter.waitForRun('codex_ses_rebind');

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]?.threadId).toBe('th_new');
    expect(stored.sessions[0]?.threadMissing).toBeUndefined();
    expect(stored.sessions[0]?.runState).toBe('started');
  });

  it('线程重新出现时恢复绑定：resume 原 id 并在磁盘上解除失效标记', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    // 之前判过失效，但用户把线程同步回来了（或换回了原来的库）
    seedThreads(codexHome, ['th_sync']);
    const seeded = new CodexSessionStore({ filePath: storePath });
    seeded.save([
      { ...STORE_BASE, id: 'codex_ses_resync', threadId: 'th_sync', runState: 'started' },
    ]);
    seeded.markThreadMissing('codex_ses_resync', 'th_sync', at(seeded, 'codex_ses_resync'));

    const calls: string[][] = [];
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => {
        calls.push(args);
        return createFakeProcess('th_sync');
      },
    });
    await adapter.loadSession('codex_ses_resync');
    await adapter.sendMessage('codex_ses_resync', '继续');
    await adapter.waitForRun('codex_ses_resync');

    // 不能因为一次「确认失效」就永久放弃这个 id：它现在是真的存在
    expect(calls[0]?.slice(0, 5)).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      'th_sync',
    ]);
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]?.threadMissing).toBeUndefined();
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain('is back');
  });

  it('已确认失效但复查失败时仍不复用死 id（持久事实优先于一次查询抖动）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    // 压根没有 state 库 → 查询只能得出 unknown
    const seeded = new CodexSessionStore({ filePath: storePath });
    seeded.save([
      { ...STORE_BASE, id: 'codex_ses_degraded', threadId: 'th_dead', runState: 'started' },
    ]);
    seeded.markThreadMissing('codex_ses_degraded', 'th_dead', at(seeded, 'codex_ses_degraded'));

    const calls: string[][] = [];
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => {
        calls.push(args);
        return createFakeProcess('th_degraded_new');
      },
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.loadSession('codex_ses_degraded');
    await adapter.sendMessage('codex_ses_degraded', '继续');
    await adapter.waitForRun('codex_ses_degraded');

    expect(calls[0]?.slice(0, 2)).toEqual(['exec', '--json']);
    // 提示只在「新确认失效」时发一次，这里不重复打扰
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'THREAD_LOST'),
    ).toHaveLength(0);
  });

  it('别人已经把线程标成失效时，本实例不能拿内存旧快照继续 resume', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    // 没有 state 库 → 本实例自己只能探测出 unknown（fail-open 会去 resume）
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_stale', threadId: 'th_dead', runState: 'started' },
    ]);

    const calls: string[][] = [];
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => {
        calls.push(args);
        return createFakeProcess('th_stale_new');
      },
    });
    // 本实例加载时磁盘上还没有失效标记
    await adapter.loadSession('codex_ses_stale');

    // 另一个 Bridge 确认了线程失效并落盘（CAS 带当前修订号）
    const other = new CodexSessionStore({ filePath: storePath });
    other.markThreadMissing('codex_ses_stale', 'th_dead', at(other, 'codex_ses_stale'));

    await adapter.sendMessage('codex_ses_stale', '继续');
    await adapter.waitForRun('codex_ses_stale');

    // 决策必须依据磁盘上的权威绑定，而不是加载时的内存快照
    expect(calls[0]?.slice(0, 2)).toEqual(['exec', '--json']);
  });

  it('过期的 thread.started 不能覆盖别处刚绑好的新身份', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_late', threadId: 'th_gone', runState: 'started' },
    ]);

    // 手动控制 stdout：spawn 之后才决定什么时候吐 thread.started。
    // ownerId 用异主机标识：这一轮的进程「已经不在了」，别的实例换绑不再被「在飞」保护挡住
    const proc = createSilentProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      ownerId: DEAD_OWNER,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_late');
    await adapter.sendMessage('codex_ses_late', '继续');

    // spawn 之后、thread.started 之前，另一个实例把身份换掉了
    const other = new CodexSessionStore({ filePath: storePath });
    other.bindThreadId('codex_ses_late', 'th_other', at(other, 'codex_ses_late'));

    (proc.stdout as PassThrough).write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'th_mine' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    // 磁盘上的新身份是别人绑的 th_other；这次执行太旧了，不能覆盖它
    expect(stored.sessions[0]?.threadId).toBe('th_other');
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain('stale run');
  });

  it('盘上没有这条记录时写不进失效标记 → 中止这一轮（不 spawn）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_vanished', threadId: 'th_gone', runState: 'started' },
    ]);

    let spawnCount = 0;
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => {
        spawnCount += 1;
        return createFakeProcess('th_never');
      },
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.loadSession('codex_ses_vanished');

    // 另一个实例把这份索引整份重写了（会话被 maxSessions 截断掉 / 换了机器）。
    // 直接写文件而不是 save()：save() 是按 id 合并的，删不掉记录。
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            ...STORE_BASE,
            id: 'codex_ses_someone_else',
            title: '别人的会话',
            threadId: 'th_x',
            runState: 'started',
          },
        ],
      }),
      'utf8',
    );

    await expect(adapter.sendMessage('codex_ses_vanished', '继续')).rejects.toThrow(/持久化失败/);
    expect(spawnCount).toBe(0);
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'THREAD_LOST'),
    ).toHaveLength(0);
  });

  it('持久化失败时不发 THREAD_LOST（没 spawn 就不许说「将尝试新建线程」）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_nopersist', threadId: 'th_gone', runState: 'started' },
    ]);

    let spawnCount = 0;
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => {
        spawnCount += 1;
        return createFakeProcess('th_never');
      },
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.loadSession('codex_ses_nopersist');

    // 另一个活进程正持锁 → starting 落盘必失败
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );

    await expect(adapter.sendMessage('codex_ses_nopersist', '继续')).rejects.toThrow(/持久化失败/);
    expect(spawnCount).toBe(0);
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'THREAD_LOST'),
    ).toHaveLength(0);
    // 磁盘上的失效标记也不能半途写进去（这一笔整个没落盘）
    rmSync(`${storePath}.lock`, { force: true });
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]?.threadMissing).toBeUndefined();
  });

  it('begin 成功后别人确认「线程回来了」，再崩溃，重启仍必须是 failed 而不是 idle', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    const store = new CodexSessionStore({ filePath: storePath });
    seedThreads(codexHome, ['th_other']); // th_gone 不在库里
    store.save([
      { ...STORE_BASE, id: 'codex_ses_confirm_race', threadId: 'th_gone', runState: 'started' },
    ]);

    // ownerId 用异主机标识 = 这一轮的进程「已经不在了」（崩溃现场）：
    // 于是别的实例的身份操作不再被「一轮执行在飞」挡着，confirm 真的会写下去
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      ownerId: DEAD_OWNER,
      spawnProcess: () => createSilentProcess(),
    });
    await adapter.loadSession('codex_ses_confirm_race');
    // 一原子转换：磁盘变成 {threadId: th_gone, threadMissing: true, runState: starting}，然后 spawn
    await adapter.sendMessage('codex_ses_confirm_race', '继续');

    // spawn 之后、thread.started 之前，另一个 Bridge 认为线程又回来了，把失效标记清掉
    expect(
      store.confirmThreadPresent(
        'codex_ses_confirm_race',
        'th_gone',
        at(store, 'codex_ses_confirm_race'),
      ).outcome,
    ).toBe('updated');
    // 紧接着这一轮崩溃：进程一句话都没吐，thread.started 也从未落盘

    const restarted = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    const statuses = new Map(
      (await restarted.listSessions()).map((session) => [session.id, session.status]),
    );
    // 身份标记可以被别人合法地改，但「这一轮跑了一半」不能因此消失：
    // 恢复成 idle 的话用户会以为消息没发出去，再发一次就是重复执行。
    expect(statuses.get('codex_ses_confirm_race')).toBe('failed');
  });

  it('两次决策都对不上磁盘身份时，宁可这一轮不发，也不开新线程', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']); // th_x 不在库里 → probe 是 missing
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_churn', runState: 'started' },
    ]);

    let spawnCount = 0;
    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => {
        spawnCount += 1;
        return proc;
      },
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    // 第一轮正常开跑：thread.started 让内存从此记着 th_x
    await adapter.sendMessage('codex_ses_churn', '继续');
    // 别的实例接管并重写了这条记录：threadId 没了，这一轮的 attempt 也易主
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        sessions: [{ ...STORE_BASE, id: 'codex_ses_churn', runState: 'started' }],
      }),
      'utf8',
    );
    (proc.stdout as PassThrough).write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'th_x' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    proc.finish(0); // 这一轮的收尾换不回任何东西：attempt 已经不属于它
    await adapter.waitForRun('codex_ses_churn');

    // 决策想开新线程（th_x 确实没了，期望值取自内存里的 th_x），但磁盘上的 threadId
    // 已经不是 th_x → identity-mismatch，两轮都没抢到 → 这一轮不发
    await expect(adapter.sendMessage('codex_ses_churn', '继续')).rejects.toThrow(
      /另一个 Nienie 实例/,
    );
    // 第二轮没有 spawn：绝不产生没人认领的新线程（幽灵线程）
    expect(spawnCount).toBe(1);
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(1);
  });

  it('换绑落盘失败时不推进内存身份，但这一轮的事件照常上报', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_persisted']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_bindfail', threadId: 'th_persisted', runState: 'started' },
    ]);

    const proc = createSilentProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.loadSession('codex_ses_bindfail');
    await adapter.sendMessage('codex_ses_bindfail', '继续');

    // 另一个 Bridge 正在写索引（持锁）→ 这次换绑必然写不进去
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    (proc.stdout as PassThrough).write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'th_mine' })}\n`,
    );
    (proc.stdout as PassThrough).write(`${JSON.stringify({ type: 'turn.started' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain('bind failed');
    // 写不进去就一点都不许改：内存若先变成 th_mine，磁盘还是 th_persisted，
    // 下一轮的决策又会以磁盘为准，两个身份来回抖动
    expect(peekThreadId(adapter, 'codex_ses_bindfail')).toBe('th_persisted');
    const read = new CodexSessionStore({ filePath: storePath }).readBinding('codex_ses_bindfail');
    expect(read.status).toBe('ok');
    if (read.status === 'ok') expect(read.binding.threadId).toBe('th_persisted');
    // 但事件必须照常上报：用户不该因为「身份没记下来」就看不到这一轮的回答
    expect(
      events.some((event) => event.type === 'status' && event.payload.status === 'running'),
    ).toBe(true);
    rmSync(`${storePath}.lock`, { force: true });
  });

  it('resume 同一个 threadId：thread.started 后 runState 必须转成 started，重启不得恢复成 failed', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_same']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_same_id', threadId: 'th_same', runState: 'started' },
    ]);

    const calls: string[][] = [];
    const proc = createManualProcess();
    // ownerId 用异主机标识：若 runState 卡在 starting，重启会被判 failed——这正是要防的回归
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      ownerId: DEAD_OWNER,
      spawnProcess: (args) => {
        calls.push(args);
        return proc;
      },
    });
    await adapter.loadSession('codex_ses_same_id');
    await adapter.sendMessage('codex_ses_same_id', '继续');

    // thread.started 带的是同一个 id：没有换绑，但收尾写入必须把 runState 从 starting 转成 started。
    // 断言必须赶在进程退出之前——退出收尾会兜底改写 runState，会把「没转成 started」的缺陷盖掉。
    (proc.stdout as PassThrough).write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'th_same' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls[0]?.slice(0, 2)).toEqual(['exec', 'resume']);
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ threadId: 'th_same', runState: 'started' });

    // 正常完成的一轮：重启后是 idle，绝不是 failed（否则用户会以为消息没发出去再发一次）
    proc.finish(0);
    await adapter.waitForRun('codex_ses_same_id');
    const restarted = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
    });
    const statuses = new Map(
      (await restarted.listSessions()).map((session) => [session.id, session.status]),
    );
    expect(statuses.get('codex_ses_same_id')).toBe('idle');
  });

  it('A begin 成功后 B confirm：A 迟到的 thread.started 不得借用 B 的修订号，也不能覆盖 B 的新状态', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']); // th_gone 不在库里
    const store = new CodexSessionStore({ filePath: storePath });
    store.save([
      { ...STORE_BASE, id: 'codex_ses_steal', threadId: 'th_gone', runState: 'started' },
    ]);
    store.markThreadMissing('codex_ses_steal', 'th_gone', at(store, 'codex_ses_steal'));

    let spawnCount = 0;
    const proc = createManualProcess();
    // ownerId 用异主机标识 = 这一轮「已经崩溃」，B 的身份操作不再被「在飞」保护挡住
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      ownerId: DEAD_OWNER,
      spawnProcess: () => {
        spawnCount += 1;
        return proc;
      },
    });
    await adapter.loadSession('codex_ses_steal');
    // A begin 成功：attempt 与 revision 都是「开跑那一次」的
    await adapter.sendMessage('codex_ses_steal', '继续');

    // A 崩溃前，另一个 Bridge 确认 th_gone 又回来了：失效标记清除、修订号推进
    const other = new CodexSessionStore({ filePath: storePath });
    expect(
      other.confirmThreadPresent('codex_ses_steal', 'th_gone', at(other, 'codex_ses_steal'))
        .outcome,
    ).toBe('updated');

    // A 迟到的 thread.started：只能拿自己的 attempt+revision 交——修订号已过期，必须被拒
    (proc.stdout as PassThrough).write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'th_new' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain('stale run');
    // B 的新状态完好（不得被 A 覆盖），th_new 不被任何记录认领
    const read = other.readBinding('codex_ses_steal');
    expect(read.status).toBe('ok');
    if (read.status === 'ok') {
      expect(read.binding.threadId).toBe('th_gone');
      expect(read.binding.threadMissing).toBeUndefined();
      expect(read.binding.revision).toBe(2);
    }
    expect(peekThreadId(adapter, 'codex_ses_steal')).toBe('th_gone');
    // A 也不许再开一个线程去「补」——那只会多出一条没人认领的幽灵线程
    expect(spawnCount).toBe(1);
    proc.finish(0);
    await adapter.waitForRun('codex_ses_steal');
  });

  it('B confirm 清掉失效标记后，A 必须全量同步并 resume 原线程（不是开新线程）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_back']);
    const store = new CodexSessionStore({ filePath: storePath });
    store.save([
      { ...STORE_BASE, id: 'codex_ses_sync3', threadId: 'th_back', runState: 'started' },
    ]);
    store.markThreadMissing('codex_ses_sync3', 'th_back', at(store, 'codex_ses_sync3'));

    const calls: string[][] = [];
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => {
        calls.push(args);
        return createFakeProcess('th_back');
      },
    });
    await adapter.loadSession('codex_ses_sync3'); // 内存里带着 threadMissing=true

    // 另一个 Bridge 确认线程回来了（磁盘清除标记）——A 还不知道
    const other = new CodexSessionStore({ filePath: storePath });
    expect(
      other.confirmThreadPresent('codex_ses_sync3', 'th_back', at(other, 'codex_ses_sync3'))
        .outcome,
    ).toBe('updated');

    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.sendMessage('codex_ses_sync3', '继续');
    await adapter.waitForRun('codex_ses_sync3');

    // 全量同步：磁盘上标记没了，内存必须跟着清（只增不减的单向同步会拿旧事实决策）
    expect(peekThreadMissing(adapter, 'codex_ses_sync3')).toBe(false);
    expect(calls[0]?.slice(0, 5)).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      'th_back',
    ]);
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'THREAD_LOST'),
    ).toHaveLength(0);
  });

  it('probe=unknown 时不得错误新建线程：磁盘已确认线程回来了就照旧 resume', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    // 压根没有 state 库 → probe 只能得出 unknown
    const store = new CodexSessionStore({ filePath: storePath });
    store.save([
      { ...STORE_BASE, id: 'codex_ses_unk', threadId: 'th_back', runState: 'started' },
    ]);
    store.markThreadMissing('codex_ses_unk', 'th_back', at(store, 'codex_ses_unk'));

    const calls: string[][] = [];
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => {
        calls.push(args);
        return createFakeProcess('th_back');
      },
    });
    await adapter.loadSession('codex_ses_unk'); // 内存里带着 threadMissing=true

    // 另一个 Bridge 确认线程回来了：磁盘事实优先于内存旧标记
    const other = new CodexSessionStore({ filePath: storePath });
    expect(
      other.confirmThreadPresent('codex_ses_unk', 'th_back', at(other, 'codex_ses_unk')).outcome,
    ).toBe('updated');

    await adapter.sendMessage('codex_ses_unk', '继续');
    await adapter.waitForRun('codex_ses_unk');

    // unknown 不是 missing：不许拿旧标记把活线程判死、换新线程（那会丢掉用户的上下文）
    expect(calls[0]?.slice(0, 5)).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      'th_back',
    ]);
  });

  it('其他 Bridge 还活着时，重启不得判 failed；重试由新一轮接管；dispose 后磁盘内容干净', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_alive', threadId: 'th_live', runState: 'started' },
    ]);

    // 第一个 Bridge：begin 成功（runState=starting + 归属本进程），进程还挂着不退出
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => createSilentProcess(),
    });
    await first.loadSession('codex_ses_alive');
    await first.sendMessage('codex_ses_alive', '继续');

    // 重启的 Bridge 看同一条记录：归属进程还活着 → 显示 running，绝不是 failed
    const calls: string[][] = [];
    const restarted = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => {
        calls.push(args);
        return createFakeProcess('th_live');
      },
    });
    const statuses = new Map(
      (await restarted.listSessions()).map((session) => [session.id, session.status]),
    );
    expect(statuses.get('codex_ses_alive')).toBe('running');

    // 重试：新一轮接管（没有执行租约，旧 attempt 让位），跑完收尾正常落盘
    await restarted.sendMessage('codex_ses_alive', '重试');
    await restarted.waitForRun('codex_ses_alive');
    expect(calls[0]?.slice(0, 2)).toEqual(['exec', 'resume']);

    // dispose 后磁盘必须是干净、可读的终态（不是半截 starting、不留锁文件）
    await restarted.dispose();
    expect(existsSync(`${storePath}.lock`)).toBe(false);
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({
      threadId: 'th_live',
      runState: 'started',
      status: 'idle',
    });
  });

  it('readBinding 读取失败不得降级成无 CAS：中止这一轮，恢复后照常能跑', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        sessions: [{ ...STORE_BASE, id: 'codex_ses_unread', threadId: 'th_live', runState: 'started' }],
      }),
      'utf8',
    );

    let spawnCount = 0;
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => {
        spawnCount += 1;
        return createFakeProcess('th_live');
      },
    });
    await adapter.loadSession('codex_ses_unread');

    // 索引临时读不动（磁盘故障 / 被人截断写了一半）——绝不能当「没有 CAS」裸跑
    writeFileSync(storePath, '{ half-written', 'utf8');
    await expect(adapter.sendMessage('codex_ses_unread', '继续')).rejects.toThrow(/身份读取失败/);
    expect(spawnCount).toBe(0);

    // 恢复后照常能写能跑（后续 Store 写入成功）
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        sessions: [{ ...STORE_BASE, id: 'codex_ses_unread', threadId: 'th_live', runState: 'started' }],
      }),
      'utf8',
    );
    await adapter.sendMessage('codex_ses_unread', '继续');
    await adapter.waitForRun('codex_ses_unread');
    expect(spawnCount).toBe(1);
  });

  it('thread.started 落盘失败后进程直接退出：退出收尾必须重试落盘，线程 ID 不能丢', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']); // th_gone 不在库里 → 开新线程
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_retry', threadId: 'th_gone', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_retry');
    await adapter.sendMessage('codex_ses_retry', '继续');

    // 另一个 Bridge 正在写索引（持锁）→ thread.started 的换绑必然写失败
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    (proc.stdout as PassThrough).write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'th_fresh' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 落盘失败时不许提前推进内存身份
    expect(peekThreadId(adapter, 'codex_ses_retry')).toBe('th_gone');
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain('bind failed');

    // 锁释放后进程立刻退出——没有下一条 JSON 事件给逐行逻辑重试，全靠退出收尾的最终重试
    rmSync(`${storePath}.lock`, { force: true });
    proc.finish(0);
    await adapter.waitForRun('codex_ses_retry');

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    // 线程 ID 不丢：th_fresh 必须落进索引（重启后 resume 它），而不是永远留在 Codex 侧无人认领
    expect(stored.sessions[0]?.threadId).toBe('th_fresh');
    expect(stored.sessions[0]?.threadMissing).toBeUndefined();
    expect(peekThreadId(adapter, 'codex_ses_retry')).toBe('th_fresh');
  });

  it('thread.started 之后、执行还在跑：另一个 Bridge 重启必须显示 running，不能退回 idle', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_started', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await first.loadSession('codex_ses_started');
    await first.sendMessage('codex_ses_started', '继续');
    // thread.started 到达 = 身份确认，但执行还在进行（进程没退出）
    (proc.stdout as PassThrough).write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'th_live' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 另一个 Bridge 重启看同一条记录：runState=started 不等于执行结束，
    // 归属进程还活着就必须显示 running——退回 idle 会让用户重发、复制出双进程执行
    const restarted = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const statuses = new Map(
      (await restarted.listSessions()).map((session) => [session.id, session.status]),
    );
    expect(statuses.get('codex_ses_started')).toBe('running');

    proc.finish(0);
    await first.waitForRun('codex_ses_started');
  });

  it('运行期 error 在 thread.started 之前：终态必须落盘，重启不得显示 running', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_runerr' }, // 全新会话：还没有 threadId
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_runerr');
    await adapter.sendMessage('codex_ses_runerr', '继续');

    // 运行期进程报错，thread.started 从未到达：这一轮必须写失败终态（starting 不许带进终态）
    proc.fail(new Error('stdio 崩了'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ status: 'failed', runState: 'never_started' });

    // 重启：显示 failed。若终态没落盘（状态/执行都停在 starting、归属进程还活着），
    // 恢复判定会把这一轮当成「还在跑」显示成 running——用户以为消息还在路上
    const restarted = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_never'),
    });
    const statuses = new Map(
      (await restarted.listSessions()).map((session) => [session.id, session.status]),
    );
    expect(statuses.get('codex_ses_runerr')).toBe('failed');
  });

  it('starting 阶段取消后，「线程回来了」的确认不得被在飞保护挡住', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']); // th_x 不在库里 → 开新线程（threadMissing + starting）
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_cancel', threadId: 'th_x', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_cancel');
    await adapter.sendMessage('codex_ses_cancel', '继续');

    // 对照：一轮真在飞时，身份操作确实被在飞保护挡着
    const other = new CodexSessionStore({ filePath: storePath });
    expect(
      other.confirmThreadPresent('codex_ses_cancel', 'th_x', at(other, 'codex_ses_cancel'))
        .outcome,
    ).toBe('in-flight');

    // starting 阶段（thread.started 未到）用户点了停止：取消必须终结这一轮的 attempt
    await adapter.cancel('codex_ses_cancel');
    await adapter.waitForRun('codex_ses_cancel');

    // 已终结的 attempt 不算在飞：此刻「th_x 又回来了」的确认必须能写下去，
    // 否则取消后的恢复确认会被永久挡死，失效标记一直清不掉
    expect(
      other.confirmThreadPresent('codex_ses_cancel', 'th_x', at(other, 'codex_ses_cancel'))
        .outcome,
    ).toBe('updated');
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]?.threadMissing).toBeUndefined();
  });

  it('旧 attempt 迟到的失败退出：不得覆盖本地/磁盘状态，也不冒充当前轮的失败', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']); // th_gone 不在库里
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_stalefail', threadId: 'th_gone', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.loadSession('codex_ses_stalefail');
    await adapter.sendMessage('codex_ses_stalefail', '继续'); // 本轮 attempt A

    // 新一轮接管：attempt B 顶掉 A（没有执行租约时，新的一轮总是接管旧的 attempt）
    const other = new CodexSessionStore({ filePath: storePath });
    const takeover = other.beginRun(
      'codex_ses_stalefail',
      at(other, 'codex_ses_stalefail'),
      '2026-11-23T02:00:00.000Z',
      OWNER,
    );
    expect(takeover.outcome).toBe('started');
    if (takeover.outcome !== 'started') return;

    // 旧 attempt A 迟到的失败退出（退出码非零）
    proc.finish(1);
    await adapter.waitForRun('codex_ses_stalefail');

    // 过期执行的失败不冒充当前 attempt 的失败：不发 RUN_FAILED，本地状态不动
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0);
    expect(peekStatus(adapter, 'codex_ses_stalefail')).toBe('running');
    // 磁盘上新一轮的状态完好：旧 attempt 的收尾一个字段都改不动
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({
      runAttempt: takeover.attempt,
      status: 'idle',
      runState: 'starting',
    });
  });
});
