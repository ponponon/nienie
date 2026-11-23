import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

    // 第一次运行：检测到旧线程不存在 → 开新线程 → 进程起来了但不吐 thread.started（崩溃）
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
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
    seeded.markThreadMissing('codex_ses_resync', 'th_sync');

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
    seeded.markThreadMissing('codex_ses_degraded', 'th_dead');

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

    // 另一个 Bridge 确认了线程失效并落盘
    new CodexSessionStore({ filePath: storePath }).markThreadMissing('codex_ses_stale', 'th_dead');

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

    // 手动控制 stdout：spawn 之后才决定什么时候吐 thread.started
    const proc = createSilentProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_late');
    await adapter.sendMessage('codex_ses_late', '继续');

    // spawn 之后、thread.started 之前，另一个实例把身份换掉了
    new CodexSessionStore({ filePath: storePath }).bindThreadId('codex_ses_late', 'th_other');

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
    seedThreads(codexHome, ['th_other']); // th_gone 不在库里
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_confirm_race', threadId: 'th_gone', runState: 'started' },
    ]);

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => createSilentProcess(),
    });
    await adapter.loadSession('codex_ses_confirm_race');
    // 一原子转换：磁盘变成 {threadId: th_gone, threadMissing: true, runState: starting}，然后 spawn
    await adapter.sendMessage('codex_ses_confirm_race', '继续');

    // spawn 之后、thread.started 之前，另一个 Bridge 认为线程又回来了，把失效标记清掉
    expect(
      new CodexSessionStore({ filePath: storePath }).confirmThreadPresent(
        'codex_ses_confirm_race',
        'th_gone',
      ),
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
    seedThreads(codexHome, ['th_other']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_churn', threadId: 'th_gone', runState: 'started' },
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
    await adapter.loadSession('codex_ses_churn'); // 内存里拿着 th_gone

    // 别的实例把这条记录的身份改没了（内存不知道），于是每次决策都以 th_gone 作期望值、
    // 又每次都被磁盘拒绝——决策连错两次
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        sessions: [{ ...STORE_BASE, id: 'codex_ses_churn', runState: 'started' }],
      }),
      'utf8',
    );

    await expect(adapter.sendMessage('codex_ses_churn', '继续')).rejects.toThrow(
      /另一个 Nienie 实例/,
    );
    // 开新线程只会得到一条「Codex 里有、手机端没有」的幽灵线程：thread.started 的 CAS
    // 必然再次被拒，没人认领这个新线程
    expect(spawnCount).toBe(0);
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
    expect(
      new CodexSessionStore({ filePath: storePath }).readBinding('codex_ses_bindfail')?.threadId,
    ).toBe('th_persisted');
    // 但事件必须照常上报：用户不该因为「身份没记下来」就看不到这一轮的回答
    expect(
      events.some((event) => event.type === 'status' && event.payload.status === 'running'),
    ).toBe(true);
    rmSync(`${storePath}.lock`, { force: true });
  });
});
