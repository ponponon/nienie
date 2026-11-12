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
});
