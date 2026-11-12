import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import { PiAdapter, PiEventNormalizer, type PiProcessHandle } from '../src/index.js';

const PI_JSON_FIXTURE = [
  { type: 'agent_start', sessionId: 'pi_ses_1' },
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: '思考解决方案' },
  },
  {
    type: 'tool_execution_start',
    toolCallId: 'pi_call_1',
    toolName: 'bash',
    args: { command: 'ls -la', secret: 'my-secret' },
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'pi_call_1',
    toolName: 'bash',
    result: 'package.json',
    isError: false,
  },
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: '已查看目录文件。' },
  },
  {
    type: 'agent_end',
    usage: { inputTokens: 300, outputTokens: 80, costUsd: 0.002 },
  },
];

describe('PiAdapter & PiEventNormalizer', () => {
  it('normalizes Pi JSON RPC stream events into Nienie canonical events', () => {
    const normalizer = new PiEventNormalizer({ machineId: 'mac_pi' });
    const events: CanonicalAgentEvent[] = [];

    for (const raw of PI_JSON_FIXTURE) {
      events.push(...normalizer.normalize('pi_ses_1', raw));
    }

    expect(events.map((e) => ({ seq: e.sequence, type: e.type, payload: e.payload }))).toEqual([
      { seq: 1, type: 'status', payload: { status: 'running', detail: 'Pi agent started' } },
      { seq: 2, type: 'thinking_delta', payload: { delta: '思考解决方案' } },
      {
        seq: 3,
        type: 'tool_use',
        payload: {
          toolCallId: 'pi_call_1',
          name: 'bash',
          input: { command: 'ls -la', secret: '[REDACTED]' },
        },
      },
      {
        seq: 4,
        type: 'tool_result',
        payload: {
          toolCallId: 'pi_call_1',
          content: 'package.json',
          isError: false,
        },
      },
      { seq: 5, type: 'text_delta', payload: { delta: '已查看目录文件。' } },
      { seq: 6, type: 'usage', payload: { inputTokens: 300, outputTokens: 80, costUsd: 0.002 } },
      { seq: 7, type: 'status', payload: { status: 'idle', detail: 'Pi agent completed' } },
    ]);
  });

  it('spawns pi --mode json and emits canonical events', async () => {
    const spawnedArgs: string[][] = [];
    const adapter = new PiAdapter({
      detectVersion: async () => 'pi 0.8.1',
      spawnProcess: (args) => {
        spawnedArgs.push(args);
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        // 模拟 Node spawn 事件时序：spawn 先于数据/退出
        setTimeout(() => emitter.emit('spawn'), 0);
        setTimeout(() => {
          for (const item of PI_JSON_FIXTURE) {
            stdout.write(`${JSON.stringify(item)}\n`);
          }
          stdout.end();
          emitter.emit('exit', 0);
        }, 0);
        return {
          stdout,
          stderr,
          kill() {},
          onExit: (cb) => emitter.on('exit', cb),
          onError: (cb) => emitter.on('error', cb),
          onSpawn: (cb) => emitter.on('spawn', cb),
        };
      },
    });

    const info = await adapter.detect();
    expect(info.available).toBe(true);
    expect(info.version).toBe('0.8.1');

    const session = await adapter.createSession({ title: 'Pi Task' });
    const received: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => received.push(e));
    await adapter.sendMessage(session.id, 'check files');
    await adapter.waitForRun(session.id); // sendMessage=接受即返回；事件在执行完成后齐备

    expect(spawnedArgs[0]).toEqual(['--mode', 'json', '--session', session.id, '-p', 'check files']);
    expect(received).toHaveLength(7);
  });

  it('F5 启动占位：并发拒绝 + spawn 失败释放可重发 + 未加载并发拒绝', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const adapter = new PiAdapter({
      detectVersion: async () => 'pi 0.8.1',
      spawnProcess: (): PiProcessHandle => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        if (mode === 'fail') {
          setTimeout(() => emitter.emit('error', new Error('spawn ENOENT')), 0);
        } else {
          setTimeout(() => emitter.emit('spawn'), 0);
          setTimeout(() => emitter.emit('exit', 0), 0);
        }
        return {
          stdout, stderr,
          kill() { emitter.emit('exit', 130); },
          onExit: (cb) => emitter.on('exit', cb),
          onError: (cb) => emitter.on('error', cb),
          onSpawn: (cb) => emitter.on('spawn', cb),
        };
      },
    });
    await adapter.detect();
    const s1 = await adapter.createSession({ title: 'F5', projectPath: '/tmp/p' });

    // 已加载并发：同步占位拒绝第二条
    mode = 'ok';
    const p1 = adapter.sendMessage(s1.id, 'first');
    await expect(adapter.sendMessage(s1.id, 'second')).rejects.toThrow(/运行中的任务/);
    await p1;
    await adapter.waitForRun(s1.id);

    // spawn 失败 → 占位释放 → 可立即重发
    mode = 'fail';
    await expect(adapter.sendMessage(s1.id, 'boom')).rejects.toThrow(/ENOENT/);
    mode = 'ok';
    await adapter.sendMessage(s1.id, 'retry ok');
    await adapter.waitForRun(s1.id);

    // 未加载 session 并发拒绝（loadSession await 窗口）
    const p2 = adapter.sendMessage('pi_unknown_f5', 'a');
    await expect(adapter.sendMessage('pi_unknown_f5', 'b')).rejects.toThrow(/运行中的任务/);
    await p2;
    await adapter.waitForRun('pi_unknown_f5');
  });

  it('F3/F5 运行期 error 持久化 + 异步 kill 锁保持 + 启动中取消持久化', async () => {
    type Behavior = {
      spawn: 'ok' | 'pending' | 'fail';
      killExit: 'sync' | 'delayed';
      autoExit?: boolean;
      runError?: boolean;
    };
    const behaviors: Behavior[] = [];
    const adapter = new PiAdapter({
      detectVersion: async () => 'pi 0.8.1',
      spawnProcess: (): PiProcessHandle => {
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
