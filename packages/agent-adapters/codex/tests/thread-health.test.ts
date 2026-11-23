import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
