import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/**
 * 假 Codex 进程：收尾语义与真实 ChildProcess 的 `close` 对齐——**「进程退出」与
 * 「stdout 关闭」都到了才触发 onExit**。真实进程的 `exit` 可能早于最后一条 stdout
 * 数据（`thread.started` 还在管道里），收尾逻辑必须等 stdio 关完，否则最终重试会
 * 排在晚到的数据之前，线程 ID 照样丢。
 *
 * 输出行（`stdout.write`）、运行期报错（`fail`）和退出时机都由测试手动控制；
 * `kill()` 异步收尾（真实 kill 的 exit/close 是异步到达的，测试可以先释放写锁、
 * 再等收尾补交落盘失败的终态）。
 */
function createTestProcess(): CodexProcessHandle & {
  finish(code?: number): void;
  fail(error?: Error): void;
  emitExit(code?: number): void;
  endStdout(): void;
} {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  let exitCode: number | null = null;
  let exited = false;
  let stdoutClosed = false;
  const exitListeners: Array<(code: number | null) => void> = [];
  const tryFire = () => {
    if (!exited || !stdoutClosed) return;
    for (const listener of exitListeners.splice(0)) listener(exitCode);
  };
  // 'end' 在所有已排队的 data 交付完之后才触发——正是「stdout 已关闭」的判据
  stdout.on('end', () => {
    stdoutClosed = true;
    tryFire();
  });
  return {
    stdout,
    stderr: new PassThrough(),
    kill() {
      setImmediate(() => {
        exited = true;
        exitCode = 130;
        stdout.end();
        tryFire();
      });
    },
    onExit(listener) {
      exitListeners.push(listener);
      tryFire();
    },
    onError(listener) {
      emitter.once('error', listener);
    },
    onSpawn(listener) {
      emitter.once('spawn', listener);
      emitter.emit('spawn');
    },
    finish(code = 0) {
      exited = true;
      exitCode = code;
      stdout.end();
      tryFire();
    },
    fail(error = new Error('stdio crashed')) {
      emitter.emit('error', error);
    },
    emitExit(code = 0) {
      exited = true;
      exitCode = code;
      tryFire();
    },
    endStdout() {
      stdout.end();
      tryFire();
    },
  };
}

/** 假 Codex 进程：只吐 thread.started，然后正常退出。 */
function createFakeProcess(threadId: string): CodexProcessHandle {
  const proc = createTestProcess();
  setTimeout(() => {
    (proc.stdout as PassThrough).write(
      `${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`,
    );
    proc.finish(0);
  }, 0);
  return proc;
}

/** 假 Codex 进程：spawn 成功后再也不吐任何东西（模拟「新线程已起、threadId 还没回来就崩溃」）。 */
function createSilentProcess(): CodexProcessHandle {
  return createTestProcess();
}

/** 假 Codex 进程：输出行、运行期报错和退出时机都由测试手动控制。 */
function createManualProcess(): ReturnType<typeof createTestProcess> {
  return createTestProcess();
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

/**
 * 轮询等待条件成立（写锁的同步退避会把重试链拖长，固定 sleep 在慢机器上会误判）。
 * 返回是否在超时前成立。
 */
async function waitForCondition(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= deadline) return fn();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

    // 运行期进程报错，thread.started 从未到达：RUN_FAILED 即时反馈、内存记失败意图，
    // 但磁盘终态到 close 才落（error ≠ 已退出，提前 finishRun 会清 runOwner 放掉执行保护）
    proc.fail(new Error('stdio 崩了'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const running = new CodexSessionStore({ filePath: storePath }).load();
    expect(running.status).toBe('ok');
    if (running.status !== 'ok') return;
    expect(running.sessions[0]?.runOwner).toBeDefined(); // 保护留到 close

    // 进程随后退出 → 终态落盘（starting 不许带进终态）
    proc.finish(1);
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

  it('旧 attempt 迟到的运行期 error：不发 RUN_FAILED、不动本地/磁盘状态（意图登记也有 fencing）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']); // th_gone 不在库里
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_staleerr', threadId: 'th_gone', runState: 'started' },
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
    await adapter.loadSession('codex_ses_staleerr');
    await adapter.sendMessage('codex_ses_staleerr', '继续'); // 本轮 attempt A

    // 新一轮接管：attempt B 顶掉 A（没有执行租约时，新的一轮总是接管旧的 attempt）
    const other = new CodexSessionStore({ filePath: storePath });
    const takeover = other.beginRun(
      'codex_ses_staleerr',
      at(other, 'codex_ses_staleerr'),
      '2026-11-23T02:00:00.000Z',
      OWNER,
    );
    expect(takeover.outcome).toBe('started');
    if (takeover.outcome !== 'started') return;

    // 旧 attempt A 运行期 error（进程还活着，没到 close）——失败意图的登记也必须过 fencing
    proc.fail(new Error('旧 attempt 运行失败'));

    // 不冒充当前轮的失败：不发 RUN_FAILED、本地状态不变（onError 同步跑完，无需等待）
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0);
    expect(peekStatus(adapter, 'codex_ses_staleerr')).toBe('running');
    // 磁盘 attempt_B 不变：连「失败意图」的确认都只读不写，收尾更不许碰
    let stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({
      runAttempt: takeover.attempt,
      status: 'idle',
      runState: 'starting',
    });

    // close 也只是把这轮进程收掉：旧 attempt 的失败退出同样动不了磁盘
    proc.finish(1);
    await adapter.waitForRun('codex_ses_staleerr');
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0);
    stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({
      runAttempt: takeover.attempt,
      status: 'idle',
      runState: 'starting',
    });
  });

  it('exit 先于最后一条 stdout 数据：收尾必须等 stdout 关完，线程 ID 不丢', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_other']); // th_gone 不在库里 → 开新线程
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_race3', threadId: 'th_gone', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_race3');
    await adapter.sendMessage('codex_ses_race3', '继续');

    // 另一个 Bridge 正在写索引（持锁）→ thread.started 的换绑必然写失败
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    // API 允许的事件顺序：exit 先到，thread.started 还在 stdout 管道里
    proc.emitExit(0);
    (proc.stdout as PassThrough).write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'th_fresh' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20)); // 晚到的数据被处理（落盘失败，pendingThreadId 记下）
    expect(peekThreadId(adapter, 'codex_ses_race3')).toBe('th_gone');

    // 锁释放后 stdout 才关——最终重试必须发生在这一刻，而不是 exit 那一刻
    rmSync(`${storePath}.lock`, { force: true });
    proc.endStdout();
    await adapter.waitForRun('codex_ses_race3');

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]?.threadId).toBe('th_fresh');
    expect(peekThreadId(adapter, 'codex_ses_race3')).toBe('th_fresh');
  });

  it('cancel 的终态落盘失败：close 时磁盘保护不放，锁释放后定时补交收干净', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_cancelfail', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_cancelfail');
    await adapter.sendMessage('codex_ses_cancelfail', '继续'); // resume → beginRun

    // 另一个 Bridge 正在写索引（持锁）→ 任何终态写入必然失败
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    await adapter.cancel('codex_ses_cancelfail');
    // UI 立即呈现取消意图（内存/cancelRequested 维度），不靠磁盘终态冒充
    expect(peekStatus(adapter, 'codex_ses_cancelfail')).toBe('cancelled');

    // kill → close（130）在锁被占下收尾：终态写不进去 → 挂起待补交。
    // 此刻磁盘上的 attempt 仍然在飞（runOwner 在场）——不许谎称已收尾，
    // 也不许提前放掉跨实例保护（confirmThreadPresent 要抢写锁，锁被占时观测不了，
    // 这里直接看 runOwner；在飞保护的完整断言见「close 前保护不许放」那条）。
    await adapter.waitForRun('codex_ses_cancelfail');
    const held = new CodexSessionStore({ filePath: storePath }).load();
    expect(held.status).toBe('ok');
    if (held.status !== 'ok') return;
    expect(held.sessions[0]?.runOwner).toBeDefined();

    // 放开锁 → 定时补交把磁盘上的 attempt 收干净（终态 + 清 runOwner）
    rmSync(`${storePath}.lock`, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ status: 'cancelled', runState: 'started' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
    // 别的 Bridge 不再把它显示成 running，身份操作不再被在飞保护挡住
    const restarted = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const statuses = new Map(
      (await restarted.listSessions()).map((session) => [session.id, session.status]),
    );
    expect(statuses.get('codex_ses_cancelfail')).toBe('cancelled');
    const other = new CodexSessionStore({ filePath: storePath });
    expect(
      other.confirmThreadPresent('codex_ses_cancelfail', 'th_live', at(other, 'codex_ses_cancelfail'))
        .outcome,
    ).not.toBe('in-flight');
  });

  it('dispose 后 close 的终态落盘失败且锁占到进程退出：退出不得把取消翻成失败，锁释放后补交', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_disposefail', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_disposefail');
    await adapter.sendMessage('codex_ses_disposefail', '继续');

    // 锁**一直占到 close 之后**：close 的终态写入必然失败 → 挂起待补交。
    //（把锁提前放掉就只测到「补交能成功」，测不到「退出不得翻案」。）
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    await adapter.dispose(); // 只记取消意图（不提前 finishRun）；kill 异步收尾
    expect(peekStatus(adapter, 'codex_ses_disposefail')).toBe('cancelled'); // 内存立即呈现取消

    // close（退出码 130）在锁被占下完成：没有 cancelRequested 守卫的话，
    // 130 会被判成执行失败、把挂起的 cancelled 翻成 failed——用户停止被伪装成执行失败。
    // dispose 会清掉事件监听，RUN_FAILED 在事件面观测不到；这里判别断言是磁盘终态。
    await adapter.waitForRun('codex_ses_disposefail');

    rmSync(`${storePath}.lock`, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 120)); // 定时补交

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    // 必须是 cancelled（取消意图胜出），绝不能是退出码翻案出来的 failed
    expect(stored.sessions[0]).toMatchObject({ status: 'cancelled' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
  });

  it('运行期 error 的终态落盘失败：close 补交前磁盘保护不放，锁释放后定时补交', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_errfail' }, // 全新会话：还没有 threadId
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
    await adapter.loadSession('codex_ses_errfail');
    await adapter.sendMessage('codex_ses_errfail', '继续');

    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    // onError 撞上写锁被占：无法确认归属 → 失败意图挂起（fail-closed），
    // 不许 fail-open 放行——最需要 fencing 的时候恰恰是锁被别人占着的时候
    proc.fail(new Error('stdio 崩了'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peekStatus(adapter, 'codex_ses_errfail')).toBe('running'); // 意图挂起，状态不动
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0); // 确认前不发
    const held = new CodexSessionStore({ filePath: storePath }).load();
    expect(held.status).toBe('ok');
    if (held.status !== 'ok') return;
    expect(held.sessions[0]?.runOwner).toBeDefined(); // 保护留到 close

    // 进程退出 → close：失败意图的最后一次确认仍无法确认归属 → 意图作废（fail-closed），
    // 只发 RUN_OUTCOME_UNKNOWN 会话提示（不置 failed）；磁盘终态走 finishRun fencing
    // （这里锁还占着，写入被挡 → 挂起待补交）
    proc.finish(1);
    await adapter.waitForRun('codex_ses_errfail').catch(() => undefined);
    expect(peekStatus(adapter, 'codex_ses_errfail')).not.toBe('failed'); // 意图没过栅栏，不置 failed
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0); // 未经确认归属的失败语义事件一律不发
    expect(
      events.filter(
        (event) => event.type === 'error' && event.payload.code === 'RUN_OUTCOME_UNKNOWN',
      ),
    ).toHaveLength(1); // 如实提示「结果无法确认」，且不置 failed
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain(
      'unconfirmed at close',
    );

    rmSync(`${storePath}.lock`, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 120)); // 定时补交

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ status: 'failed', runState: 'never_started' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
    // 全程 RUN_FAILED 一次都不发：失败意图没过归属栅栏，只有 RUN_OUTCOME_UNKNOWN 如实提示
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0);
    expect(
      events.filter(
        (event) => event.type === 'error' && event.payload.code === 'RUN_OUTCOME_UNKNOWN',
      ),
    ).toHaveLength(1);
  });

  it('cancel 之后 kill 失败触发 onError：不得把 cancelled 翻成 failed', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_killfail', threadId: 'th_live', runState: 'started' },
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
    await adapter.loadSession('codex_ses_killfail');
    await adapter.sendMessage('codex_ses_killfail', '继续');

    // 持锁：close 的终态也写不进去（挂起 {cancelled}）。kill 失败的 onError 若不被
    // 「已取消」守卫挡住，会把这一轮翻成 failed（写盘 + 发 RUN_FAILED）——
    // 用户主动取消被伪装成执行失败。
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    await adapter.cancel('codex_ses_killfail');
    proc.fail(new Error('kill 失败：进程无法终止'));
    rmSync(`${storePath}.lock`, { force: true });

    await adapter.waitForRun('codex_ses_killfail').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30)); // 等收尾补交（如仍有挂起）

    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0);
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    // 最终状态必须是 cancelled（取消意图胜出），绝不能是 onError 写的 failed
    expect(stored.sessions[0]).toMatchObject({ status: 'cancelled' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
  });

  it('cancel 后 close 前跨实例执行保护不许放：kill ≠ 已退出', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_p21', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_p21');
    await adapter.sendMessage('codex_ses_p21', '继续');

    proc.kill = () => {}; // kill 只是信号：进程此刻还没退出
    await adapter.cancel('codex_ses_p21');
    expect(peekStatus(adapter, 'codex_ses_p21')).toBe('cancelled'); // UI 立即呈现取消

    // close 之前磁盘终态不许写（runOwner 不许清）：此刻放掉保护，
    // 另一个 Bridge 会以为这一轮已结束、立刻开出第二轮。
    const other = new CodexSessionStore({ filePath: storePath });
    expect(
      other.confirmThreadPresent('codex_ses_p21', 'th_live', at(other, 'codex_ses_p21')).outcome,
    ).toBe('in-flight');

    proc.emitExit(130);
    proc.endStdout(); // close 到此才真正收尾
    await adapter.waitForRun('codex_ses_p21');

    // close 之后：终态落盘、runOwner 清掉、保护放行
    expect(
      other.confirmThreadPresent('codex_ses_p21', 'th_live', at(other, 'codex_ses_p21')).outcome,
    ).not.toBe('in-flight');
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ status: 'cancelled', runState: 'started' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
  });

  it('cancel 后的 onError 不许提前 resolve waitForRun：进程真正收尾才兑现', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_p22', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_p22');
    await adapter.sendMessage('codex_ses_p22', '继续');

    proc.kill = () => {}; // 手动控制 close 时机
    await adapter.cancel('codex_ses_p22');
    proc.fail(new Error('kill 失败：进程无法终止')); // 取消后 error 只负责被忽略

    // error 之后、close 之前：waitForRun 必须保持 pending——
    // 进程可能还活着（kill 未必退得掉），error 不是「这一轮已收尾」的凭据。
    const settled = await Promise.race([
      adapter.waitForRun('codex_ses_p22').then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ]);
    expect(settled).toBe('pending');

    proc.emitExit(130);
    proc.endStdout();
    await adapter.waitForRun('codex_ses_p22'); // close 才兑现
  });

  it('close 之后迟到的 error 不许把挂起的取消终态翻成失败', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_lateerr', threadId: 'th_live', runState: 'started' },
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
    await adapter.loadSession('codex_ses_lateerr');
    await adapter.sendMessage('codex_ses_lateerr', '继续');

    // 持锁到 close 之后：close 的取消终态写不进去 → 挂起 {cancelled}。
    // 此时 cancelRequested 已在 close 消费、内存终态也没推进——
    // 迟到的 error 若不被「已收尾」守卫挡住，会把挂起的 cancelled 覆盖成 failed。
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    await adapter.cancel('codex_ses_lateerr');
    await adapter.waitForRun('codex_ses_lateerr'); // close（130）在锁被占下完成
    proc.fail(new Error('迟到的 stdio 错误')); // close 之后才到的 error

    rmSync(`${storePath}.lock`, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 120)); // 定时补交

    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0);
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ status: 'cancelled' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
  });

  it('记录被别的实例删掉：终态不许谎称已落盘，本地照常收尾并留诊断', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_gone' }, // 全新会话：还没有 threadId
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
    await adapter.loadSession('codex_ses_gone');
    await adapter.sendMessage('codex_ses_gone', '继续'); // beginRun → attempt 在飞

    // 另一个实例把这条记录从索引里删掉
    const loaded = new CodexSessionStore({ filePath: storePath }).load();
    if (loaded.status !== 'ok') throw new Error('store unreadable');
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        sessions: loaded.sessions.filter((session) => session.id !== 'codex_ses_gone'),
      }),
      'utf8',
    );

    proc.finish(0); // 正常退出 → 终态写入发现记录已不在索引里
    await adapter.waitForRun('codex_ses_gone');

    // 本地照常收尾：展示不许卡在「运行中」
    expect(peekStatus(adapter, 'codex_ses_gone')).toBe('idle');
    // 如实暴露：诊断里明确说「没写进索引」，不许谎称 applied
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain(
      'run outcome not persisted (record missing from index)',
    );
    // 不留挂起（重试也不可能找回）：不许误报「终态未持久化」
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(0);
  });

  it('dispose 不得提前写终态放掉执行保护：close 才落盘（kill ≠ 已退出）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_dprotect', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_dprotect');
    await adapter.sendMessage('codex_ses_dprotect', '继续');

    proc.kill = () => {}; // dispose 只是发信号：进程此刻还没退出
    await adapter.dispose();

    // dispose 不得提前 finishRun（写盘成功也不行）：runOwner 还在，跨实例保护仍在——
    // 此刻放掉保护，另一个 Bridge 的 beginRun 会开出第二轮，两个 Codex 进程抢同一会话。
    const other = new CodexSessionStore({ filePath: storePath });
    expect(
      other.confirmThreadPresent('codex_ses_dprotect', 'th_live', at(other, 'codex_ses_dprotect'))
        .outcome,
    ).toBe('in-flight');
    const held = new CodexSessionStore({ filePath: storePath }).load();
    expect(held.status).toBe('ok');
    if (held.status !== 'ok') return;
    expect(held.sessions[0]?.runOwner).toBeDefined();

    proc.emitExit(130);
    proc.endStdout(); // close 到此才真正收尾
    await adapter.waitForRun('codex_ses_dprotect');

    // close 之后：cancelled 终态落盘、runOwner 清掉、保护放行
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ status: 'cancelled', runState: 'started' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
    expect(
      other.confirmThreadPresent('codex_ses_dprotect', 'th_live', at(other, 'codex_ses_dprotect'))
        .outcome,
    ).not.toBe('in-flight');
  });

  it('运行期 error 不得提前写终态放掉执行保护：close 才落失败终态', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_eprotect', threadId: 'th_live', runState: 'started' },
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
    await adapter.loadSession('codex_ses_eprotect');
    await adapter.sendMessage('codex_ses_eprotect', '继续');

    proc.fail(new Error('stdio 崩了')); // error ≠ 已退出

    // onError 只反馈（RUN_FAILED）+ 内存失败意图；磁盘 runOwner 保留——
    // error 时就 finishRun 等于提前放掉跨实例执行保护，另一个 Bridge 会开出第二轮。
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(1);
    const other = new CodexSessionStore({ filePath: storePath });
    expect(
      other.confirmThreadPresent('codex_ses_eprotect', 'th_live', at(other, 'codex_ses_eprotect'))
        .outcome,
    ).toBe('in-flight');
    const held = new CodexSessionStore({ filePath: storePath }).load();
    expect(held.status).toBe('ok');
    if (held.status !== 'ok') return;
    expect(held.sessions[0]?.runOwner).toBeDefined();

    // error 之后、close 之前：waitForRun 必须保持 pending（error 不是收尾凭据）
    const settled = await Promise.race([
      adapter
        .waitForRun('codex_ses_eprotect')
        .then(() => 'resolved' as const)
        .catch(() => 'rejected' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ]);
    expect(settled).toBe('pending');

    proc.finish(1); // 进程随后退出
    await adapter.waitForRun('codex_ses_eprotect').catch(() => undefined); // close 才兑现

    // close 之后：failed 终态落盘、runOwner 清掉、保护放行
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ status: 'failed', runState: 'started' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
    expect(
      other.confirmThreadPresent('codex_ses_eprotect', 'th_live', at(other, 'codex_ses_eprotect'))
        .outcome,
    ).not.toBe('in-flight');
    // RUN_FAILED 只反馈一次：close 落盘不重发
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(1);
  });

  it('error 之后 exit(0)：close 直接落 failed，不许被正常收尾降级成 idle', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_err0', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_err0');
    await adapter.sendMessage('codex_ses_err0', '继续');

    proc.fail(new Error('stdio 崩了')); // 失败意图已成立
    proc.finish(0); // 却以 0 退出——exit(0) 不得把 failed 降级成 idle
    await adapter.waitForRun('codex_ses_err0').catch(() => undefined);

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ status: 'failed', runState: 'started' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
  });

  it('error 后 exit(0) 且终态落盘失败：补交的也必须是 failed，不是 idle', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_err0fail', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_err0fail');
    await adapter.sendMessage('codex_ses_err0fail', '继续');

    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    proc.fail(new Error('stdio 崩了')); // pending 的意图是 failed
    proc.finish(0); // close(0)：写不进去 → 挂起——挂起的也必须是 failed
    await adapter.waitForRun('codex_ses_err0fail').catch(() => undefined);

    rmSync(`${storePath}.lock`, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 120)); // 定时补交

    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({ status: 'failed', runState: 'started' });
    expect(stored.sessions[0]?.runOwner).toBeUndefined();
  });

  it('定时补交到上限必须停止：放弃只报一次，锁释放后不许偷偷复活', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_retrycap', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_retrycap');
    await adapter.sendMessage('codex_ses_retrycap', '继续');

    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    await adapter.cancel('codex_ses_retrycap');
    await adapter.waitForRun('codex_ses_retrycap').catch(() => undefined); // close 写入失败 → 挂起

    // 每次失败写入会被写锁的同步退避（10+20+40ms）拖住——轮询等放弃信号，不用固定 sleep
    expect(
      await waitForCondition(() =>
        adapter
          .getDiagnostics()
          .historyRecoveryErrors.some((line) => line.includes('giving up')),
      ),
    ).toBe(true);

    const givingUps = adapter
      .getDiagnostics()
      .historyRecoveryErrors.filter((line) => line.includes('giving up'));
    expect(givingUps).toHaveLength(1); // 只放弃一次（计时器回调自己续链会反复放弃）
    // 白盒确认链子已断：放弃后不许残留定时器（否则计数清零、无限重试）
    const timers = (adapter as unknown as { pendingRetryTimers: Map<string, unknown> })
      .pendingRetryTimers;
    expect(timers.size).toBe(0);

    // 放弃就是放弃：锁释放后不许有隐性重试把磁盘悄悄收干净（那是没上报过的写入）
    rmSync(`${storePath}.lock`, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]?.runOwner).toBeDefined();
  });

  it('dispose 换新实例后，最终放弃的终态仍可观察（跨 Adapter 生命周期）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_xlife', threadId: 'th_live', runState: 'started' },
    ]);

    const proc = createManualProcess();
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await first.loadSession('codex_ses_xlife');
    await first.sendMessage('codex_ses_xlife', '继续');

    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    proc.kill = () => {}; // 手动控制 close
    await first.cancel('codex_ses_xlife');
    proc.emitExit(130);
    proc.endStdout(); // close：终态写入被锁挡 → 挂起 → 重试到放弃
    await first.waitForRun('codex_ses_xlife').catch(() => undefined);
    await first.dispose(); // 旧实例到此为止（监听器已清，内存诊断没人看得见）

    // 轮询等 give-up 把最终失败落盘（sidecar）——固定 sleep 在慢机器上会误判
    expect(await waitForCondition(() => existsSync(`${storePath}.stale-outcomes`))).toBe(true);

    // 新 Adapter 加载后必须能看到这条最终失败（事件 + 诊断），而不是永远沉默
    const second = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    second.onEvent((event) => events.push(event));
    await second.loadSession('codex_ses_xlife');
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
    expect(second.getDiagnostics().historyRecoveryErrors.join('\n')).toContain(
      '终态最终未能写入本地索引',
    );

    // serve-once：同一个实例第二次进入不再重复弹同一条
    const third = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const again: CanonicalAgentEvent[] = [];
    third.onEvent((event) => again.push(event));
    await third.loadSession('codex_ses_xlife');
    expect(
      again.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(0);
  });

  it('真实 Bridge 启动顺序（先 listSessions 后 onEvent）：sidecar 送达前不许消费、送达后才删盘', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_order', threadId: 'th_live', runState: 'started' },
    ]);
    // 上一个实例重试到放弃留下的最终失败提示（它是怎么产生的已有专门测试覆盖）
    const sidecar = `${storePath}.stale-outcomes`;
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        sessionId: 'codex_ses_order',
        at: '2026-11-24T03:00:00.000Z',
        message: `codex session codex_ses_order: 终态最终未能写入本地索引（重试已放弃），其他窗口可能仍把它显示成运行中`,
      })}\n`,
      'utf8',
    );

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });

    // 真实 BridgeServer.start() 的顺序：先 listSessions()，此时还没有任何事件监听器
    await adapter.listSessions();
    // 没人听就不许消费、不许删盘：事件尚未送达，记录必须原样留在盘上
    expect(existsSync(sidecar)).toBe(true);

    // onEvent 注册的瞬间才有人听：待发的最终失败提示在此送达
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
    // 送达成功后才确认消费（删盘）；送达前删盘 = 提示被静默吞掉
    expect(existsSync(sidecar)).toBe(false);

    // 已确认消费：同一实例后续进入不重复弹
    await adapter.loadSession('codex_ses_order');
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
  });

  it('sidecar 原子领取：两个 Adapter 同时消费同一份 sidecar 只送达一次', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_race', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        sessionId: 'codex_ses_race',
        at: '2026-11-24T06:00:00.000Z',
        message: 'codex session codex_ses_race: 终态最终未能写入本地索引（重试已放弃），其他窗口可能仍把它显示成运行中',
      })}\n`,
      'utf8',
    );

    const makeAdapter = () =>
      new CodexAdapter({
        codexHome,
        defaultProjectPath: PROJECT,
        sessionStorePath: storePath,
        spawnProcess: (args) => createFakeProcess('th_live'),
      });
    const a = makeAdapter();
    const b = makeAdapter();
    const eventsA: CanonicalAgentEvent[] = [];
    const eventsB: CanonicalAgentEvent[] = [];
    a.onEvent((event) => eventsA.push(event));
    b.onEvent((event) => eventsB.push(event));
    // 两个进程/实例同时进入消费入口：rename 领取是原子的，只有一个能拿到记录
    await a.loadSession('codex_ses_race');
    await b.loadSession('codex_ses_race');
    const countA = eventsA.filter(
      (event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED',
    ).length;
    const countB = eventsB.filter(
      (event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED',
    ).length;
    expect(countA + countB).toBe(1); // 同一条提示不许被发两次
    expect(existsSync(sidecar)).toBe(false); // 主文件已被领取
    expect(
      readdirSync(dirname(storePath)).filter((name) => name.includes('.claim')),
    ).toEqual([]); // 送达后领取副本也删干净
  });

  it('旧实例晚到的 sidecar 写入仍能被活着的 Adapter 读到（不存在即锁死加载）', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_late', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    // 第一次进入：还没有 sidecar（旧实例的放弃定时器还没到点）
    await adapter.loadSession('codex_ses_late');
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(0);

    // 旧实例的定时器此刻才把最终失败写出来（新 Adapter 已经启动）
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        sessionId: 'codex_ses_late',
        at: '2026-11-24T06:10:00.000Z',
        message: 'codex session codex_ses_late: 终态最终未能写入本地索引（重试已放弃），其他窗口可能仍把它显示成运行中',
      })}\n`,
      'utf8',
    );

    // 晚到的记录不许因为「第一次没见到文件」就被永久拒收
    await adapter.loadSession('codex_ses_late');
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
  });

  it('dispose 把没送达的领取副本放回共享池：提示不随 Adapter 生命周期消失', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_relay', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        sessionId: 'codex_ses_relay',
        at: '2026-11-24T06:20:00.000Z',
        message: 'codex session codex_ses_relay: 终态最终未能写入本地索引（重试已放弃），其他窗口可能仍把它显示成运行中',
      })}\n`,
      'utf8',
    );

    // 一个「中间层注册方」：自己没有下游，收到一律明确未送达（return false）
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const proxyEvents: CanonicalAgentEvent[] = [];
    first.onEvent((event) => {
      proxyEvents.push(event);
      return false;
    });
    // onEvent 的 flush 已经把提示发给中间层（明确未送达 → 保留副本等重试）
    expect(
      proxyEvents.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1); // 发给中间层了，但没确认送达

    await first.dispose(); // 领取副本必须放回共享池，不许被带走

    const second = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    second.onEvent((event) => events.push(event));
    await second.loadSession('codex_ses_relay');
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
    expect(existsSync(sidecar)).toBe(false);
  });

  it('claim 文件名按实例区分：同进程双 Adapter 领取不互相覆盖，两批记录各送达一次', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_batch1', threadId: 'th_live', runState: 'started' },
      { ...STORE_BASE, id: 'codex_ses_batch2', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    const line = (sessionId: string, message: string) =>
      `${JSON.stringify({ sessionId, at: '2026-11-24T07:00:00.000Z', message })}\n`;
    writeFileSync(sidecar, line('codex_ses_batch1', '批次一终态没写进索引'), 'utf8');

    // A：领取批次一，但一直没确认送达（中间层）
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const proxyEvents: CanonicalAgentEvent[] = [];
    first.onEvent((event) => {
      proxyEvents.push(event);
      return false;
    });
    expect(
      proxyEvents.filter(
        (event) => event.type === 'error' && event.sessionId === 'codex_ses_batch1',
      ),
    ).toHaveLength(1);

    // 原路径追加第二批（A 的领取副本还挂着、没确认送达）
    writeFileSync(sidecar, line('codex_ses_batch2', '批次二终态没写进索引'), { flag: 'a' });

    // B：同一进程的另一个实例。claim 文件名只带 pid 时会 rename 覆盖 A 的副本
    const second = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    second.onEvent((event) => events.push(event));
    expect(
      events.filter(
        (event) => event.type === 'error' && event.sessionId === 'codex_ses_batch2',
      ),
    ).toHaveLength(1);

    // A dispose：批次一的未确认副本放回共享池（不许被 B 的同名 claim 顶掉后删丢）
    await first.dispose();

    // B 重新送达：批次一到达
    second.flushPendingNotices();
    const deliveries = events.filter(
      (event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED',
    );
    expect(
      deliveries.filter((event) => event.sessionId === 'codex_ses_batch1'),
    ).toHaveLength(1);
    expect(
      deliveries.filter((event) => event.sessionId === 'codex_ses_batch2'),
    ).toHaveLength(1);
    expect(existsSync(sidecar)).toBe(false);
  });

  it('sidecar 的 append 与 claim 共用锁：锁被占时 append 不抢写（意图进队列），锁释放后自动补写', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([{ ...STORE_BASE, id: 'codex_ses_lock' }]);
    const sidecar = `${storePath}.stale-outcomes`;
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });

    // 另一个写入者正持有 sidecar 锁（append 与 rename 都必须等它）
    writeFileSync(
      `${sidecar}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    (adapter as unknown as { persistStaleOutcomeNotice(sessionId: string): void })
      .persistStaleOutcomeNotice('codex_ses_lock');
    // 不许锁外抢写（否则 fd 会被 claim 的 rename 带走、字节随副本被删）；
    // 失败的意图进待写队列，不许就此丢掉
    expect(existsSync(sidecar)).toBe(false);
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain(
      'stale outcome notice append failed; queued for retry',
    );

    // 锁释放后由待写队列**自动补写**（生产路径的定时重试，不是手动再调一次）
    rmSync(`${sidecar}.lock`, { force: true });
    expect(
      await waitForCondition(() => existsSync(sidecar)),
    ).toBe(true);
    expect(readFileSync(sidecar, 'utf8')).toContain('codex_ses_lock');
  });

  it('claim 的 rename 也持同一把锁：锁被占时不领取，提示留在原地等下一轮', () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_cl', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        sessionId: 'codex_ses_cl',
        at: '2026-11-24T08:00:00.000Z',
        message: 'codex session codex_ses_cl: 终态最终未能写入本地索引（重试已放弃）',
      })}\n`,
      'utf8',
    );
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    writeFileSync(
      `${sidecar}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    adapter.onEvent((event) => events.push(event));
    // 锁被占：不 rename、不领取——append 的 fd 可能还开着，此刻领走就会把新字节带走
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(0);
    expect(existsSync(sidecar)).toBe(true);

    // 锁释放后下一轮照常领取送达
    rmSync(`${sidecar}.lock`, { force: true });
    adapter.flushPendingNotices();
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
    expect(existsSync(sidecar)).toBe(false);
  });

  it('孤儿 claim 的收编是原子 rename：两个实例先后收编同一孤儿只送达一次', () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_orph', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    // 持有者进程已死的孤儿 claim 文件（收编只许认领一次）
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }).pid;
    expect(deadPid).toBeGreaterThan(0);
    writeFileSync(
      `${sidecar}.${deadPid}.deadbeef-0000-0000-0000-000000000000.1.claim`,
      `${JSON.stringify({
        sessionId: 'codex_ses_orph',
        at: '2026-11-24T08:30:00.000Z',
        message: 'codex session codex_ses_orph: 终态最终未能写入本地索引（重试已放弃）',
      })}\n`,
      'utf8',
    );

    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const second = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    // 两个实例先后扫到同一个孤儿：原地认领会各解析一份（同一提示发两次）
    const claimA = first as unknown as { claimStaleOutcomeFiles(): void };
    const claimB = second as unknown as { claimStaleOutcomeFiles(): void };
    claimA.claimStaleOutcomeFiles();
    claimB.claimStaleOutcomeFiles();

    const eventsA: CanonicalAgentEvent[] = [];
    const eventsB: CanonicalAgentEvent[] = [];
    first.onEvent((event) => eventsA.push(event));
    second.onEvent((event) => eventsB.push(event));
    const delivered = [...eventsA, ...eventsB].filter(
      (event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED',
    );
    expect(delivered).toHaveLength(1);
  });

  it('dispose 归还失败的 claim 不永久滞留：同进程新实例按实例标识收编，恰好送达一次', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_rel', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    const dir = dirname(storePath);
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        noticeId: 'n_rel',
        sessionId: 'codex_ses_rel',
        at: '2026-11-24T09:00:00.000Z',
        message: 'codex session codex_ses_rel: 终态最终未能写入本地索引（重试已放弃）',
      })}\n`,
      'utf8',
    );

    // A 领取但不确认送达（中间层）
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    first.onEvent(() => false);
    // 归还需要的锁被占：A dispose 归还失败，claim 副本（名字带 A 的实例标识）留在盘上
    writeFileSync(
      `${sidecar}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    await first.dispose();
    expect(readdirSync(dir).filter((name) => name.endsWith('.claim'))).toHaveLength(1);

    // 释锁 → B（同进程、新实例）：只认 pid 会把 A 的残留当「活人不抢」永久滞留——
    // 进程活着 ≠ 实例活着，A 已 dispose（实例标识已注销），B 必须能收编
    rmSync(`${sidecar}.lock`, { force: true });
    const second = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    second.onEvent((event) => events.push(event));
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
    expect(readdirSync(dir).filter((name) => name.endsWith('.claim'))).toHaveLength(0);
  });

  it('通知意图不随 dispose 丢失：append 与归还都失败时落成 claim 副本，新实例收编送达', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_fb', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    const dir = dirname(storePath);
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });

    // give-up 写入撞锁：意图进待写队列（不丢），dispose 时锁仍被占
    writeFileSync(
      `${sidecar}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    (first as unknown as { persistStaleOutcomeNotice(sessionId: string): void })
      .persistStaleOutcomeNotice('codex_ses_fb');
    await first.dispose(); // 最后补写仍撞锁 → 落成本实例名下的 claim 副本
    expect(existsSync(sidecar)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith('.claim'))).toHaveLength(1);

    // 锁释放后新实例收编：最终通知必须还能到达
    rmSync(`${sidecar}.lock`, { force: true });
    const second = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    second.onEvent((event) => events.push(event));
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
  });

  it('崩溃双副本按 noticeId 幂等：共享路径 + claim 副本同一条只送达一次（eventId 稳定）', () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_dup', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    // 崩溃场景：append 成功、删 claim 前进程没了——同一条记录在共享路径和 claim 副本各一份
    const entry = {
      noticeId: 'n_dup',
      sessionId: 'codex_ses_dup',
      at: '2026-11-24T09:30:00.000Z',
      message: 'codex session codex_ses_dup: 终态最终未能写入本地索引（重试已放弃）',
    };
    writeFileSync(sidecar, `${JSON.stringify(entry)}\n`, 'utf8');
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }).pid;
    expect(deadPid).toBeGreaterThan(0);
    writeFileSync(
      `${sidecar}.${deadPid}.deadbeef-0000-0000-0000-000000000000.1.claim`,
      `${JSON.stringify(entry)}\n`,
      'utf8',
    );

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event)); // 同一次 flush：领取共享副本 + 收编孤儿副本
    const delivered = events.filter(
      (event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED',
    );
    expect(delivered).toHaveLength(1);
    // eventId 从稳定 noticeId 派生：崩溃后重新摄取还是同一个 eventId，客户端幂等去重有据
    expect(delivered[0]?.eventId).toBe('notice:codex_ses_dup:PERSIST_FAILED:n_dup');
  });

  it('dispose 之后晚到的通知仍有收尾者：重试链到限自落 claim 兜底，新实例收编送达', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([{ ...STORE_BASE, id: 'codex_ses_late' }]);
    const sidecar = `${storePath}.stale-outcomes`;
    const dir = dirname(storePath);
    const first = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    await first.dispose(); // 实例已注销——此后产生的通知没有第二次 dispose 可指望

    // 晚到的 give-up（onExit 收尾 / 补交链）：锁被占，append 失败
    writeFileSync(
      `${sidecar}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    (first as unknown as { persistStaleOutcomeNotice(sessionId: string): void })
      .persistStaleOutcomeNotice('codex_ses_late');
    // 重试链到限自落 claim 兜底（独立 finalizer，不依赖 dispose）
    expect(
      await waitForCondition(
        () => readdirSync(dir).filter((name) => name.endsWith('.claim')).length === 1,
        5000,
      ),
    ).toBe(true);
    // 原子落盘（临时文件 + rename）：不残留半截可消费记录
    expect(readdirSync(dir).filter((name) => name.includes('.new'))).toHaveLength(0);

    // 释锁 → 新实例收编送达一次
    rmSync(`${sidecar}.lock`, { force: true });
    const second = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    second.onEvent((event) => events.push(event));
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
  });

  it('claim 兜底也失败时重试链不停止：低频退避续试，目录恢复后自动补写送达', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([{ ...STORE_BASE, id: 'codex_ses_bp' }]);
    const sidecar = `${storePath}.stale-outcomes`;
    const dir = dirname(storePath);
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    // 目录只读：append 与 claim 兜底同时写不进（锁文件也建不出来）
    execFileSync('chmod', ['555', dir]);
    try {
      (adapter as unknown as { persistStaleOutcomeNotice(sessionId: string): void })
        .persistStaleOutcomeNotice('codex_ses_bp');
      // 到限后兜底也失败：不停链，低频退避续试；内存队列不算持久化，措辞不许暗示已经安全
      expect(
        await waitForCondition(
          () =>
            adapter
              .getDiagnostics()
              .historyRecoveryErrors.join('\n')
              .includes('still retrying at low frequency (not yet persisted)'),
          5000,
        ),
      ).toBe(true);
      expect(readdirSync(dir).filter((name) => name.endsWith('.claim'))).toHaveLength(0);
      expect(existsSync(sidecar)).toBe(false);
    } finally {
      execFileSync('chmod', ['755', dir]);
    }
    // 目录恢复可写：链条自己把通知补进共享池（不靠手动重调、不靠新实例）
    expect(await waitForCondition(() => existsSync(sidecar), 8000)).toBe(true);
    adapter.flushPendingNotices();
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
  });

  it('损坏的 claim 副本不静默删：好记录照常送达，损坏行保留并隔离 .corrupt', () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_cm', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    const dir = dirname(storePath);
    // 一行好记录 + 半截损坏行（模拟写入中被 SIGKILL 的旧格式 claim）
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        noticeId: 'n_ok',
        sessionId: 'codex_ses_cm',
        at: '2026-11-24T10:00:00.000Z',
        message: 'codex session codex_ses_cm: 终态最终未能写入本地索引',
      })}\n{"sessionId": "codex_ses_cm", "mess\n`,
      'utf8',
    );

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    // 好记录照常送达
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
    // 副本不许当「重复记录」删掉：送达后隔离改名 .corrupt（损坏行可能是唯一副本）
    expect(readdirSync(dir).filter((name) => name.endsWith('.claim.corrupt'))).toHaveLength(1);
    expect(readdirSync(dir).filter((name) => name.endsWith('.claim'))).toHaveLength(0);
  });

  it('全损坏的 claim 副本不等送达立即隔离 .corrupt：没有可送内容，dispose 不归还共享池空转', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_cm2', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    const dir = dirname(storePath);
    // 整份副本只有一条半截损坏行：一条有效记录都解析不出来
    writeFileSync(sidecar, '{"sessionId": "codex_ses_cm2", "mess\n', 'utf8');

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    // 没有可送内容 → 不必等送达：立即隔离改名 .corrupt 保留证据（可能是唯一副本）
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(0);
    expect(readdirSync(dir).filter((name) => name.endsWith('.claim'))).toHaveLength(0);
    expect(readdirSync(dir).filter((name) => name.endsWith('.claim.corrupt'))).toHaveLength(1);
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain(
      'quarantined immediately',
    );
    // 不许被 dispose 归还共享池：全损坏副本反复领取-归还是空转循环
    await adapter.dispose();
    expect(existsSync(sidecar)).toBe(false);
  });

  it('崩溃在「临时文件写完、rename 之前」：.claim.new 残留被收编，PERSIST_FAILED 恰好送达一次', () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_tmp', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    const dir = dirname(storePath);
    // 崩溃现场：fallbackNoticeToClaim 写完临时文件、正式 rename 还没执行
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }).pid;
    writeFileSync(
      `${sidecar}.${deadPid}.deadbeef-0000-0000-0000-000000000000.1.claim.new`,
      `${JSON.stringify({
        noticeId: 'n_tmp',
        sessionId: 'codex_ses_tmp',
        at: '2026-11-24T10:00:00.000Z',
        message: 'codex session codex_ses_tmp: 终态最终未能写入本地索引（上一个实例重试已放弃）',
      })}\n`,
      'utf8',
    );

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    const delivered = events.filter(
      (event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED',
    );
    expect(delivered).toHaveLength(1);
    // noticeId 全程保留：eventId 与写入时的稳定标识一致（客户端幂等去重有据）
    expect(delivered[0]?.eventId).toBe('notice:codex_ses_tmp:PERSIST_FAILED:n_tmp');
    // 收编完成：无 .new 残留；内容合法所以没有隔离件
    expect(readdirSync(dir).filter((name) => name.includes('.new'))).toHaveLength(0);
    expect(readdirSync(dir).filter((name) => name.endsWith('.corrupt'))).toHaveLength(0);
  });

  it('崩溃残留的 .claim.new 内容撕裂：隔离保留证据，不静默删也不误送', () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_torn', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    const dir = dirname(storePath);
    // 写入到一半被 SIGKILL：半截 JSON、没有收尾换行
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }).pid;
    const tmpName = `${sidecar}.${deadPid}.deadbeef-0000-0000-0000-000000000000.2.claim.new`;
    writeFileSync(tmpName, '{"noticeId": "n_torn", "sessionId": "codex_ses_tor', 'utf8');

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    // 半截记录不是合法记录：不许送出去
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(0);
    // 不许静默删：隔离改名保留证据，内容原样还在
    expect(existsSync(tmpName)).toBe(false);
    expect(existsSync(`${tmpName}.corrupt`)).toBe(true);
    expect(readFileSync(`${tmpName}.corrupt`, 'utf8')).toContain('n_torn');
  });

  it('.claim.new 的收编认实例不认 PID：活跃实例的临时文件不动，实例注销后才收编', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_live', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    const dir = dirname(storePath);
    const options = {
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args: string[]) => createFakeProcess('th_live'),
    };
    const first = new CodexAdapter(options);
    const second = new CodexAdapter(options);
    // first 正在写兜底临时文件（rename 之前）——它还活着，second 不许碰
    const firstOwner = (first as unknown as { claimOwnerId: string }).claimOwnerId;
    const tmpName = `${sidecar}.${process.pid}.${firstOwner}.1.claim.new`;
    writeFileSync(
      tmpName,
      `${JSON.stringify({
        noticeId: 'n_live',
        sessionId: 'codex_ses_live',
        at: '2026-11-24T10:00:00.000Z',
        message: 'codex session codex_ses_live: 终态最终未能写入本地索引',
      })}\n`,
      'utf8',
    );
    const events: CanonicalAgentEvent[] = [];
    second.onEvent((event) => events.push(event));
    // 同进程 ≠ 同实例：first 还活跃（含自己实例的 .new 同样不碰）
    expect(existsSync(tmpName)).toBe(true);
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(0);

    // first 注销实例标识（进程还活着）：此刻才认定为死实例残留，收编送达一次
    await first.dispose();
    second.flushPendingNotices();
    const delivered = events.filter(
      (event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED',
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.eventId).toBe('notice:codex_ses_live:PERSIST_FAILED:n_live');
    expect(readdirSync(dir).filter((name) => name.includes('.new'))).toHaveLength(0);
    await second.dispose();
  });

  it('旧格式记录（无 noticeId）的双副本按内容哈希确定性去重：只送达一次', () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_old', threadId: 'th_live', runState: 'started' },
    ]);
    const sidecar = `${storePath}.stale-outcomes`;
    // 升级前留下的旧格式记录（没有 noticeId），崩溃双副本
    const legacy = `${JSON.stringify({
      sessionId: 'codex_ses_old',
      at: '2026-11-24T10:30:00.000Z',
      message: 'codex session codex_ses_old: 终态最终未能写入本地索引',
    })}\n`;
    writeFileSync(sidecar, legacy, 'utf8');
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }).pid;
    expect(deadPid).toBeGreaterThan(0);
    writeFileSync(
      `${sidecar}.${deadPid}.deadbeef-0000-0000-0000-000000000000.1.claim`,
      legacy,
      'utf8',
    );

    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: (args) => createFakeProcess('th_live'),
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'PERSIST_FAILED'),
    ).toHaveLength(1);
  });

  it('RUN_FAILED 的核对与发送在写锁临界区内：事件发出的瞬间写锁还占着，beginRun 插不进', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_atomic' }, // 全新会话
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    let lockHeldDuringRunFailed = false;
    adapter.onEvent((event) => {
      if (event.type === 'error' && event.payload.code === 'RUN_FAILED') {
        // 核对与发送之间没有锁窗口的直接证据：事件到达监听器时写锁还被占着，
        // 另一个实例的 beginRun 此刻只能撞锁失败，插不进「查完到发事件之间」
        lockHeldDuringRunFailed = existsSync(`${storePath}.lock`);
      }
    });
    await adapter.loadSession('codex_ses_atomic');
    await adapter.sendMessage('codex_ses_atomic', '继续');

    proc.fail(new Error('运行炸了'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lockHeldDuringRunFailed).toBe(true);
  });

  it('监听器异常逐个隔离：RUN_FAILED 仍只发一次，close 正常释放锁、waitForRun 正常 settle', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_lsnr' },
    ]);

    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event)); // 监听器 1：只记录
    adapter.onEvent((event) => {
      // 监听器 2：见到 RUN_FAILED 就炸。不许把监听器 1 一起拖下水，
      // 也不许因此把失败意图当成「登记失败」再登记一次（RUN_FAILED 发两次）
      if (event.type === 'error' && event.payload.code === 'RUN_FAILED') {
        throw new Error('监听器炸了');
      }
      return true;
    });
    await adapter.loadSession('codex_ses_lsnr');
    await adapter.sendMessage('codex_ses_lsnr', '继续');

    proc.fail(new Error('运行炸了'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 监听器 1 不受监听器 2 的异常影响，RUN_FAILED 只发一次（不因异常重复登记）
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(1);
    // 一个监听器的异常不许吞掉同批派发的后续事件：emitRunError 的第二半
    // （status:failed）必须照常到达监听器 1——异常隔离的专属观测面
    expect(
      events.filter((event) => event.type === 'status' && event.payload.status === 'failed'),
    ).toHaveLength(1);
    // 异常记在监听器隔离的诊断通道上（不是被登记守卫吞掉的那种）
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).toContain(
      'event listener threw',
    );

    proc.finish(1);
    await expect(adapter.waitForRun('codex_ses_lsnr')).rejects.toThrow('运行炸了');

    // close 正常释放 sessionLocks、终态照常落盘：单个监听器故障不打断收尾
    const internal = adapter as unknown as { sessionLocks: Set<string> };
    expect(internal.sessionLocks.has('codex_ses_lsnr')).toBe(false);
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]?.status).toBe('failed');
  });

  it('close 时归属无法确认且已被接管：不发 RUN_FAILED、不置 failed，磁盘不被翻案', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    seedThreads(codexHome, ['th_live']);
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_unconf', threadId: 'th_live', runState: 'started' },
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
    await adapter.loadSession('codex_ses_unconf');
    await adapter.sendMessage('codex_ses_unconf', '继续'); // attempt A

    // A 的运行期 error 撞上写锁：归属无法确认 → 失败意图挂起
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    proc.fail(new Error('A 炸了'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0);

    // 锁释放 → B 接管：磁盘上已是 attempt_B
    rmSync(`${storePath}.lock`, { force: true });
    const other = new CodexSessionStore({ filePath: storePath });
    const takeover = other.beginRun(
      'codex_ses_unconf',
      at(other, 'codex_ses_unconf'),
      '2026-11-24T08:00:00.000Z',
      OWNER,
    );
    expect(takeover.outcome).toBe('started');
    if (takeover.outcome !== 'started') return;

    // 重新占锁 → A close：最后一次归属确认仍 unavailable → 失败意图作废（fail-closed）
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    proc.finish(1);
    await adapter.waitForRun('codex_ses_unconf'); // 正常收尾（不以未经确认的失败 reject）

    // 1) 不产生 RUN_FAILED；2) 不产生 status=failed（本地状态也不许翻成 failed）
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0);
    expect(
      events.filter(
        (event) => event.type === 'status' && event.payload.status === 'failed',
      ),
    ).toHaveLength(0);
    expect(peekStatus(adapter, 'codex_ses_unconf')).not.toBe('failed');
    // 结果无法确认如实提示（RUN_OUTCOME_UNKNOWN 是会话级提示，不置 failed）
    expect(
      events.filter(
        (event) => event.type === 'error' && event.payload.code === 'RUN_OUTCOME_UNKNOWN',
      ),
    ).toHaveLength(1);

    // 3)+4) A 的终态写入被 fencing 拒绝（stale-attempt），磁盘仍属于 attempt_B
    rmSync(`${storePath}.lock`, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 120)); // 挂起终态的补交也是 stale 拒绝
    const stored = new CodexSessionStore({ filePath: storePath }).load();
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;
    expect(stored.sessions[0]).toMatchObject({
      runAttempt: takeover.attempt, // 仍是 B 的
      status: 'idle',
      runState: 'starting',
    });
    expect(
      events.filter((event) => event.type === 'error' && event.payload.code === 'RUN_FAILED'),
    ).toHaveLength(0);
  });

  it('旧 attempt 的补交定时器不得烧掉新 attempt 的重试预算：预算按 attempt 隔离', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_budget' },
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
    await adapter.loadSession('codex_ses_budget');
    await adapter.sendMessage('codex_ses_budget', '继续');

    const internal = adapter as unknown as {
      stashPendingRunOutcome: (
        sessionId: string,
        attempt: string | undefined,
        patch: { status: string },
      ) => void;
      schedulePendingRetry: (sessionId: string) => void;
      pendingRetryCounts: Map<string, { attempt: string | undefined; count: number }>;
      pendingRetryTimers: Map<string, { attempt: string | undefined; timer: ReturnType<typeof setTimeout> }>;
      pendingRunOutcomes: Map<string, { attempt: string | undefined; patch: unknown }>;
    };

    // 锁一直占着 → attempt A 的补交重试持续失败，计数烧到 4
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    internal.stashPendingRunOutcome('codex_ses_budget', 'attempt_A', { status: 'failed' });
    internal.schedulePendingRetry('codex_ses_budget');
    expect(
      await waitForCondition(
        () => (internal.pendingRetryCounts.get('codex_ses_budget')?.count ?? 0) >= 4,
      ),
    ).toBe(true);

    // 新 attempt 接管并挂上自己的落盘失败：旧定时器与旧计数必须整体作废。
    // attempt_B 用真实的 runAttempt（磁盘 fencing 只认它），attempt_A 是旧轮次
    const beginState = new CodexSessionStore({ filePath: storePath }).load();
    expect(beginState.status).toBe('ok');
    if (beginState.status !== 'ok') return;
    const realAttempt = beginState.sessions[0]?.runAttempt;
    expect(realAttempt).toBeTruthy();
    internal.stashPendingRunOutcome('codex_ses_budget', realAttempt, { status: 'failed' });
    expect(internal.pendingRetryTimers.has('codex_ses_budget')).toBe(false); // 旧定时器清掉
    expect(internal.pendingRetryCounts.get('codex_ses_budget')).toBeUndefined(); // 预算归零

    // B 自己排的补交在锁释放后必须走满自己的预算：不许被 A 的遗留计数顶到 give-up
    internal.schedulePendingRetry('codex_ses_budget');
    rmSync(`${storePath}.lock`, { force: true });
    expect(
      await waitForCondition(() => {
        const stored = new CodexSessionStore({ filePath: storePath }).load();
        return (
          stored.status === 'ok' &&
          stored.sessions[0]?.status === 'failed' &&
          stored.sessions[0]?.runOwner === undefined
        );
      }),
    ).toBe(true);
    // A 的 4 次失败不许记到 B 头上：give-up 一次都不该出现
    expect(adapter.getDiagnostics().historyRecoveryErrors.join('\n')).not.toContain('giving up');
  });

  it('补交定时器的 attempt 核对：旧 attempt 的定时器对上新 pending 必须就地退出', async () => {
    const codexHome = makeDir('nienie-codex-home-');
    const storePath = join(makeDir('nienie-store-'), 'codex-sessions.json');
    new CodexSessionStore({ filePath: storePath }).save([
      { ...STORE_BASE, id: 'codex_ses_timer' },
    ]);
    const proc = createManualProcess();
    const adapter = new CodexAdapter({
      codexHome,
      defaultProjectPath: PROJECT,
      sessionStorePath: storePath,
      spawnProcess: () => proc,
    });
    await adapter.loadSession('codex_ses_timer');
    await adapter.sendMessage('codex_ses_timer', '继续');

    const internal = adapter as unknown as {
      stashPendingRunOutcome: (
        sessionId: string,
        attempt: string | undefined,
        patch: { status: string },
      ) => void;
      schedulePendingRetry: (sessionId: string) => void;
      pendingRetryCounts: Map<string, { attempt: string | undefined; count: number }>;
      pendingRunOutcomes: Map<string, { attempt: string | undefined; patch: unknown }>;
    };

    // attempt A 排出补交定时器（锁占着，注定失败重试）
    writeFileSync(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }),
      'utf8',
    );
    internal.stashPendingRunOutcome('codex_ses_timer', 'attempt_A', { status: 'failed' });
    internal.schedulePendingRetry('codex_ses_timer');

    // pending 换成 attempt B，但**绕过 stash**（直接改单槽）——专打定时器回调里的
    // attempt 核对守卫：stash 的清定时器守卫在这条路径上不可达，两个守卫各要各的观测面
    internal.pendingRunOutcomes.set('codex_ses_timer', {
      attempt: 'attempt_B',
      patch: { status: 'failed' },
    });

    // A 的定时器到点后必须发现 pending 已易主、就地退出：B 的预算一点都不能少
    await new Promise((resolve) => setTimeout(resolve, 250)); // 覆盖 A 的首次回调（50ms + 写锁退避）
    expect(internal.pendingRetryCounts.get('codex_ses_timer')).toBeUndefined();
    rmSync(`${storePath}.lock`, { force: true });
  });
});
