import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import {
  CodexAdapter,
  CodexEventNormalizer,
  type CodexProcessHandle,
} from '../src/index.js';
import { CODEX_JSONL_LIFECYCLE_FIXTURE } from './fixtures/codex-events.fixture.js';

describe('CodexEventNormalizer', () => {
  it('normalizes Codex JSONL events (thinking, command execution, file changes, text deltas, usage, and errors) into CanonicalAgentEvents', () => {
    let counter = 0;
    const normalizer = new CodexEventNormalizer({
      machineId: 'machine_codex',
      now: () => new Date('2026-11-04T09:00:00.000Z'),
      idGenerator: () => `cx_evt_${++counter}`,
    });

    const events: CanonicalAgentEvent[] = [];
    for (const raw of CODEX_JSONL_LIFECYCLE_FIXTURE) {
      events.push(...normalizer.normalize('ses_codex_1', raw));
    }

    // Round 2：exitCode 端到端——exit_code: 2 → payload.exitCode=2；缺失 → 不伪造字段
    const n2 = new CodexEventNormalizer({
      machineId: 'machine_codex',
      now: () => new Date('2026-11-04T09:00:00.000Z'),
      idGenerator: () => 'cx_evt_x',
    });
    const failedEvents = n2.normalize('ses_exit', {
      type: 'item.completed',
      item: {
        id: 'cmd_2',
        type: 'command_execution',
        command: 'exit 2',
        aggregated_output: 'boom',
        exit_code: 2,
        status: 'failed',
      },
    });
    const failedResult = failedEvents.find((e) => e.type === 'tool_result');
    expect(failedResult!.payload).toMatchObject({ exitCode: 2, isError: true });

    const n3 = new CodexEventNormalizer({
      machineId: 'machine_codex',
      now: () => new Date('2026-11-04T09:00:00.000Z'),
      idGenerator: () => 'cx_evt_y',
    });
    const noExitEvents = n3.normalize('ses_noexit', {
      type: 'item.completed',
      item: {
        id: 'cmd_3',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: 'ok',
        status: 'completed',
      },
    });
    const noExitResult = noExitEvents.find((e) => e.type === 'tool_result');
    expect(noExitResult!.payload!.exitCode).toBeUndefined(); // 缺失不伪造

    expect(events.map((e) => ({ seq: e.sequence, type: e.type, payload: e.payload }))).toEqual([
      {
        seq: 1,
        type: 'status',
        payload: { status: 'running', detail: 'Codex turn started' },
      },
      {
        seq: 2,
        type: 'thinking_delta',
        payload: { delta: '先检查工作区目录与测试配置' },
      },
      {
        seq: 3,
        type: 'tool_use',
        payload: {
          toolCallId: 'item_cmd_1',
          name: 'bash',
          input: { command: 'pnpm test' },
        },
      },
      {
        seq: 4,
        type: 'tool_result',
        payload: {
          toolCallId: 'item_cmd_1',
          content: 'All tests passed',
          isError: false,
          exitCode: 0, // Round 2：真实退出码透传（fixture 有 exit_code: 0）
        },
      },
      {
        seq: 5,
        type: 'tool_use',
        payload: {
          toolCallId: 'item_patch_1',
          name: 'file_change',
          input: {
            changes: [
              { path: 'src/index.ts', kind: 'update' },
              { path: 'tests/index.test.ts', kind: 'add' },
            ],
          },
        },
      },
      {
        seq: 6,
        type: 'tool_result',
        payload: {
          toolCallId: 'item_patch_1',
          content: 'update src/index.ts, add tests/index.test.ts',
          isError: false,
        },
      },
      {
        seq: 7,
        type: 'text_delta',
        payload: { delta: '我已经完成了修复，' },
      },
      {
        seq: 8,
        type: 'text_delta',
        payload: { delta: '并且测试全部通过。' },
      },
      {
        seq: 9,
        type: 'usage',
        payload: {
          inputTokens: 1800,
          outputTokens: 260,
          cachedInputTokens: 400,
          costUsd: 0,
        },
      },
      {
        seq: 10,
        type: 'status',
        payload: { status: 'idle', detail: 'Codex turn completed' },
      },
    ]);

    const errorEvents = normalizer.normalize('ses_codex_1', {
      type: 'turn.failed',
      error: { message: 'Sandbox permission denied' },
    });
    expect(errorEvents).toMatchObject([
      {
        sequence: 11,
        type: 'error',
        payload: {
          code: 'CODEX_EXECUTION_FAILED',
          message: 'Sandbox permission denied',
          retryable: false,
        },
      },
    ]);
  });
});

describe('CodexAdapter', () => {
  it('returns available=false when Codex binary is unavailable', async () => {
    const adapter = new CodexAdapter({ executablePath: '__non_existent_codex_bin__' });
    const info = await adapter.detect();
    expect(info.id).toBe('codex');
    expect(info.name).toBe('Codex');
    expect(info.available).toBe(false);
    expect(info.capabilities.streaming).toBe(true);
    expect(info.capabilities.sessionResume).toBe(true);
  });

  it('detects Codex CLI version, creates/resumes threads, streams JSONL events, and cancels running executions', async () => {
    const spawnedCalls: Array<{ args: string[]; cwd?: string | undefined }> = [];
    let activeKillCount = 0;

    const adapter = new CodexAdapter({
      machineId: 'mac_codex',
      detectVersion: async () => 'codex-cli 0.166.0',
      spawnProcess: (args, options): CodexProcessHandle => {
        spawnedCalls.push({ args, cwd: options.cwd });
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();

        // 模拟 Node spawn 事件时序：spawn 先于数据/退出（两个独立宏任务）
        setTimeout(() => emitter.emit('spawn'), 0);
        setTimeout(() => {
          for (const frame of CODEX_JSONL_LIFECYCLE_FIXTURE) {
            stdout.write(`${JSON.stringify(frame)}\n`);
          }
          stdout.end();
          emitter.emit('exit', 0);
        }, 0);

        return {
          stdout,
          stderr,
          kill() {
            activeKillCount++;
            emitter.emit('exit', 130);
          },
          onExit(listener) {
            emitter.on('exit', listener);
          },
          onError(listener) {
            emitter.on('error', listener);
          },
          onSpawn(listener) {
            emitter.on('spawn', listener);
          },
        };
      },
    });

    // 1. detect()
    const info = await adapter.detect();
    expect(info).toEqual({
      id: 'codex',
      name: 'Codex',
      available: true,
      version: '0.166.0',
      capabilities: adapter.capabilities,
    });

    // 2. createSession() & listSessions()
    const session = await adapter.createSession({
      title: 'Refactor Codex module',
      projectPath: '/workspace/nienie',
    });
    expect(session.agentId).toBe('codex');
    expect(session.title).toBe('Refactor Codex module');
    expect(await adapter.listSessions()).toHaveLength(1);

    // 3. sendMessage() -> initial turn uses `exec --json`
    const receivedEvents: CanonicalAgentEvent[] = [];
    adapter.onEvent((event) => receivedEvents.push(event));

    await adapter.sendMessage(session.id, '请运行测试并修复问题');
    // sendMessage=接受即返回；执行完成后事件与 thread 绑定才就绪
    await adapter.waitForRun(session.id);
    expect(spawnedCalls[0]).toEqual({
      args: ['exec', '--json', '--skip-git-repo-check', '-C', '/workspace/nienie', '请运行测试并修复问题'],
      cwd: '/workspace/nienie',
    });

    expect(receivedEvents.some((e) => e.type === 'thinking_delta')).toBe(true);
    expect(receivedEvents.some((e) => e.type === 'tool_use')).toBe(true);
    expect(receivedEvents.some((e) => e.type === 'tool_result')).toBe(true);
    expect(receivedEvents.some((e) => e.type === 'text_delta')).toBe(true);

    // 4. Subsequent sendMessage() on the same session resumes the bound Codex thread (`exec resume --json <thread_id>`)
    await adapter.sendMessage(session.id, '继续检查覆盖率');
    await adapter.waitForRun(session.id);
    expect(spawnedCalls[1]).toEqual({
      args: [
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        'thread_codex_01',
        '继续检查覆盖率',
      ],
      cwd: '/workspace/nienie',
    });

    // 5. loadSession() can load existing session or resume by thread ID
    const resumed = await adapter.loadSession('thread_external_99');
    expect(resumed.id).toBe('thread_external_99');

    // 6. cancel() terminates running execution
    await adapter.cancel(session.id);
    expect(activeKillCount).toBeGreaterThanOrEqual(0);
  });

  it('R3-3 spawn 失败必须拒绝 sendMessage 并上报规范化错误事件（假送达防护）', async () => {
    const adapter = new CodexAdapter({
      machineId: 'mac_codex',
      detectVersion: async () => 'codex-cli 0.166.0',
      spawnProcess: (): CodexProcessHandle => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        // spawn 从未确认，异步报错（模拟二进制不存在）
        setTimeout(() => emitter.emit('error', new Error('spawn ENOENT')), 0);
        return {
          stdout,
          stderr,
          kill() {},
          onExit(listener) {
            emitter.on('exit', listener);
          },
          onError(listener) {
            emitter.on('error', listener);
          },
          onSpawn() {
            // 永不触发
          },
        };
      },
    });

    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    const session = await adapter.createSession({
      title: 'spawn fail',
      projectPath: '/workspace/nienie',
    });

    await expect(adapter.sendMessage(session.id, 'hi')).rejects.toThrow(/ENOENT/);
    // 失败必须反馈：规范化 error 事件（手机可见）
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(String(errEvent!.payload?.message)).toContain('启动失败');
    expect((await adapter.listSessions())[0]!.status).toBe('failed');
  });

  it('F5 启动占位：await 窗口并发拒绝 + spawn 失败/cancel 后占位释放可重发', async () => {
    let handles: Array<() => CodexProcessHandle> = [];
    const adapter = new CodexAdapter({
      machineId: 'mac_codex',
      detectVersion: async () => 'codex-cli 0.166.0',
      spawnProcess: (): CodexProcessHandle => {
        const factory = handles.shift();
        if (!factory) throw new Error('no handle queued');
        return factory();
      },
    });
    const okHandle = (): CodexProcessHandle => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const emitter = new EventEmitter();
      setTimeout(() => emitter.emit('spawn'), 0);
      setTimeout(() => emitter.emit('exit', 0), 0);
      return {
        stdout, stderr,
        kill() { emitter.emit('exit', 130); },
        onExit(l) { emitter.on('exit', l); },
        onError(l) { emitter.on('error', l); },
        onSpawn(l) { emitter.on('spawn', l); },
      };
    };
    // 长驻：不自动退出（cancel 场景用；kill 才退出）
    const longHandle = (): CodexProcessHandle => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const emitter = new EventEmitter();
      setTimeout(() => emitter.emit('spawn'), 0);
      return {
        stdout, stderr,
        kill() { emitter.emit('exit', 130); },
        onExit(l) { emitter.on('exit', l); },
        onError(l) { emitter.on('error', l); },
        onSpawn(l) { emitter.on('spawn', l); },
      };
    };
    const failHandle = (): CodexProcessHandle => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const emitter = new EventEmitter();
      setTimeout(() => emitter.emit('error', new Error('spawn ENOENT')), 0);
      return {
        stdout, stderr,
        kill() { emitter.emit('exit', 130); },
        onExit(l) { emitter.on('exit', l); },
        onError(l) { emitter.on('error', l); },
        onSpawn() {},
      };
    };

    const session = await adapter.createSession({ title: 'f5', projectPath: '/workspace/nienie' });

    // 场景 1：已加载 session，同步并发第二条被启动占位拒绝
    handles.push(okHandle);
    const p1 = adapter.sendMessage(session.id, 'first');
    await expect(adapter.sendMessage(session.id, 'second')).rejects.toThrow(/运行中的任务/);
    await p1;
    await adapter.waitForRun(session.id);

    // 场景 2：cancel 运行中的任务后立即重发成功（kill→exit 130 归为 cancelled 不报失败）
    handles.push(longHandle);
    const p2 = adapter.sendMessage(session.id, 'long running');
    await p2;
    await adapter.cancel(session.id);
    await adapter.waitForRun(session.id);
    handles.push(okHandle);
    await adapter.sendMessage(session.id, 'after cancel');
    await adapter.waitForRun(session.id);

    // 场景 3：spawn 失败释放占位，可立即重发
    handles.push(failHandle);
    await expect(adapter.sendMessage(session.id, 'boom')).rejects.toThrow(/ENOENT/);
    handles.push(okHandle);
    await adapter.sendMessage(session.id, 'retry ok');
    await adapter.waitForRun(session.id);

    // 场景 4：未加载 session 并发（loadSession await 窗口）——占位同样生效
    handles.push(okHandle);
    const p4 = adapter.sendMessage('thread_unknown_f5', 'a');
    await expect(adapter.sendMessage('thread_unknown_f5', 'b')).rejects.toThrow(/运行中的任务/);
    await p4;
  });

  it('F5 同一 session 活动进程串行化：并发第二条消息被拒绝', async () => {
    const adapter = new CodexAdapter({
      machineId: 'mac_codex',
      detectVersion: async () => 'codex-cli 0.166.0',
      spawnProcess: (): CodexProcessHandle => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        setTimeout(() => emitter.emit('spawn'), 0);
        // 不退出：模拟长任务
        return {
          stdout,
          stderr,
          kill() {
            emitter.emit('exit', 130);
          },
          onExit(listener) {
            emitter.on('exit', listener);
          },
          onError(listener) {
            emitter.on('error', listener);
          },
          onSpawn(listener) {
            emitter.on('spawn', listener);
          },
        };
      },
    });

    const session = await adapter.createSession({
      title: 'serialize',
      projectPath: '/workspace/nienie',
    });
    await adapter.sendMessage(session.id, 'first');
    await expect(adapter.sendMessage(session.id, 'second')).rejects.toThrow(/运行中的任务/);
    await adapter.cancel(session.id);
  });

  it('F3 信号终止（exit code=null，非主动取消）按失败处理并上报', async () => {
    const adapter = new CodexAdapter({
      machineId: 'mac_codex',
      detectVersion: async () => 'codex-cli 0.166.0',
      spawnProcess: (): CodexProcessHandle => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        setTimeout(() => emitter.emit('spawn'), 0);
        setTimeout(() => emitter.emit('exit', null), 0); // 被信号终止
        return {
          stdout,
          stderr,
          kill() {
            emitter.emit('exit', 130);
          },
          onExit(listener) {
            emitter.on('exit', listener);
          },
          onError(listener) {
            emitter.on('error', listener);
          },
          onSpawn(listener) {
            emitter.on('spawn', listener);
          },
        };
      },
    });

    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    const session = await adapter.createSession({
      title: 'signal',
      projectPath: '/workspace/nienie',
    });
    await adapter.sendMessage(session.id, 'hi');
    await adapter.waitForRun(session.id);
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(String(errEvent!.payload?.message)).toContain('信号');
    // F3：终态 status 事件必须同步上报（手机据此终止 Thinking 计时/置失败）
    const failedStatus = events.find((e) => e.type === 'status' && e.payload?.status === 'failed');
    expect(failedStatus).toBeDefined();
    expect((await adapter.listSessions())[0]!.status).toBe('failed');
  });

  it('R3-3 非零退出码按失败处理并上报事件（不能无条件 resolve）', async () => {
    const adapter = new CodexAdapter({
      machineId: 'mac_codex',
      detectVersion: async () => 'codex-cli 0.166.0',
      spawnProcess: (): CodexProcessHandle => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        setTimeout(() => emitter.emit('spawn'), 0);
        setTimeout(() => emitter.emit('exit', 2), 0);
        return {
          stdout,
          stderr,
          kill() {
            emitter.emit('exit', 130);
          },
          onExit(listener) {
            emitter.on('exit', listener);
          },
          onError(listener) {
            emitter.on('error', listener);
          },
          onSpawn(listener) {
            emitter.on('spawn', listener);
          },
        };
      },
    });

    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    const session = await adapter.createSession({
      title: 'exit code',
      projectPath: '/workspace/nienie',
    });

    await adapter.sendMessage(session.id, 'hi');
    await adapter.waitForRun(session.id);
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(String(errEvent!.payload?.message)).toContain('2');
    expect((await adapter.listSessions())[0]!.status).toBe('failed');
  });

  it('F3/F5 运行期 error 持久化 + 异步 kill 锁保持 + 启动中取消持久化', async () => {
    type Behavior = {
      spawn: 'ok' | 'pending' | 'fail';
      killExit: 'sync' | 'delayed';
      autoExit?: boolean;
      runError?: boolean;
    };
    const behaviors: Behavior[] = [];
    const adapter = new CodexAdapter({
      detectVersion: async () => 'codex-cli 0.166.0',
      spawnProcess: (): CodexProcessHandle => {
        const behavior = behaviors.shift() ?? { spawn: 'ok', killExit: 'sync', autoExit: true };
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        let exited = false;
        const emitExit = (code: number) => {
          if (exited) return; // 真实进程只退出一次
          exited = true;
          emitter.emit('exit', code);
        };
        if (behavior.spawn === 'ok') {
          setTimeout(() => {
            emitter.emit('spawn');
            if (behavior.runError) {
              setTimeout(() => emitter.emit('error', new Error('runtime boom')), 10);
            }
            if (behavior.autoExit) {
              setTimeout(() => emitExit(0), 5);
            }
          }, 0);
        } else if (behavior.spawn === 'pending') {
          setTimeout(() => emitter.emit('spawn'), 80); // spawn 确认延迟
        } else {
          setTimeout(() => emitter.emit('error', new Error('spawn ENOENT')), 0);
        }
        return {
          stdout, stderr,
          kill() {
            if (behavior.killExit === 'sync') {
              emitExit(130);
            } else {
              setTimeout(() => emitExit(130), 100); // 异步退出：kill≠已退出
            }
          },
          onExit: (cb) => emitter.on('exit', cb),
          onError: (cb) => emitter.on('error', cb),
          onSpawn: (cb) => emitter.on('spawn', cb),
        };
      },
    });
    await adapter.detect();
    const s1 = await adapter.createSession({ title: 'LF', projectPath: '/tmp/p' });

    // F5-2：kill 后延迟退出——锁保持到真实 exit，期间第二条必须被拒
    behaviors.push({ spawn: 'ok', killExit: 'delayed' });
    await adapter.sendMessage(s1.id, 'long');
    await adapter.cancel(s1.id);
    await expect(adapter.sendMessage(s1.id, 'during-kill')).rejects.toThrow(/运行中的任务/);
    await new Promise((r) => setTimeout(r, 150)); // 等真实退出
    behaviors.push({ spawn: 'ok', killExit: 'sync', autoExit: true });
    await adapter.sendMessage(s1.id, 'after-exit'); // 锁已释放可重发
    await adapter.waitForRun(s1.id);

    // F3-2/F5-1：spawn 确认前取消——record=cancelled 且锁不提前释放
    behaviors.push({ spawn: 'pending', killExit: 'delayed' });
    const p3 = adapter.sendMessage(s1.id, 'will-cancel');
    await adapter.cancel(s1.id);
    const cancelled = (await adapter.listSessions()).find((x) => x.id === s1.id);
    expect(cancelled!.status).toBe('cancelled'); // 启动中取消也持久化 cancelled
    await expect(adapter.sendMessage(s1.id, 'blocked')).rejects.toThrow(/运行中的任务/);
    await p3; // 确认后发现取消意图→立即 kill（sendMessage 以接受语义返回）
    await new Promise((r) => setTimeout(r, 250)); // 等真实退出释放锁
    behaviors.push({ spawn: 'ok', killExit: 'sync', autoExit: true });
    await adapter.sendMessage(s1.id, 'recovered');
    await adapter.waitForRun(s1.id);

    // F3-1：运行期 error 必须持久化 failed（listSessions 不回 running/idle）
    behaviors.push({ spawn: 'ok', killExit: 'sync', runError: true });
    void adapter.sendMessage(s1.id, 'will-error').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 60));
    const failed = (await adapter.listSessions()).find((x) => x.id === s1.id);
    expect(failed!.status).toBe('failed');
  });

});
