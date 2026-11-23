// 多进程锁测试用 worker：直接加载 TS 源（Node 22 的类型剥离），
// 每个进程只写自己那一批 id，最终文件里必须一条不少。
//
// 关于重试：生产代码在锁被占用时只退避约 70ms 就抛错（由诊断暴露），因为 Bridge 不该为了
// 一次落盘长时间阻塞事件循环。这里 worker 自己重试，是为了把两件事分开验证：
// 「互斥在真实多进程竞争下是否成立」与「退避窗口对真实使用频率是否够用」。
import { CodexSessionStore } from '../../src/session-store.ts';

const [storePath, prefix, countRaw] = process.argv.slice(2);
const count = Number(countRaw);

if (!storePath || !prefix || !Number.isFinite(count)) {
  console.error('usage: save-worker.mjs <storePath> <prefix> <count>');
  process.exit(2);
}

const store = new CodexSessionStore({ filePath: storePath });
const base = {
  title: `${prefix}`,
  projectPath: '/workspace/nienie',
  status: 'idle',
  createdAt: '2026-11-23T00:00:00.000Z',
};

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function saveWithRetry(record) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      store.save([record]);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('被其他写入者占用')) throw error;
      sleepSync(5);
    }
  }
  throw new Error('worker 重试 200 次仍抢不到锁');
}

try {
  for (let i = 0; i < count; i += 1) {
    saveWithRetry({
      ...base,
      id: `${prefix}_${i}`,
      threadId: `th_${prefix}_${i}`,
      updatedAt: new Date().toISOString(),
    });
  }
} catch (error) {
  console.error(`worker ${prefix} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

process.exit(0);
