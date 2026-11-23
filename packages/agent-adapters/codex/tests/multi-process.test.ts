import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexSessionStore } from '../src/index.js';

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(new URL('./fixtures/save-worker.mjs', import.meta.url));
const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nienie-multiproc-'));
  createdDirs.push(dir);
  return dir;
}

/**
 * 真正在两个进程里并发写同一份索引。
 *
 * 这是对「文件锁 + 合并」唯一的硬验证：单进程测试里 save() 是同步的，插不进第二个写者，
 * 只有真实子进程才能制造竞争。断言看结果不看过程——两条流水线各写 N 条，
 * 最终文件里必须一条不少（丢一条就说明互斥失效或合并被整份覆盖）。
 */
describe('多进程并发写同一份会话索引', () => {
  it('两个进程各写 25 条，最终一条不丢，也不留锁文件', async () => {
    const dir = makeDir();
    const storePath = join(dir, 'codex-sessions.json');

    await Promise.all([
      execFileAsync(process.execPath, [workerPath, storePath, 'codex_ses_a', '25']),
      execFileAsync(process.execPath, [workerPath, storePath, 'codex_ses_b', '25']),
    ]);

    const result = new CodexSessionStore({ filePath: storePath }).load();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const ids = new Set(result.sessions.map((session) => session.id));
    expect(ids.size).toBe(50);
    for (const prefix of ['codex_ses_a', 'codex_ses_b']) {
      for (let i = 0; i < 25; i += 1) {
        expect(ids.has(`${prefix}_${i}`)).toBe(true);
      }
    }
    // 每个进程写完都释放了锁，不该有残留
    expect(existsSync(`${storePath}.lock`)).toBe(false);
  }, 60_000);
});
