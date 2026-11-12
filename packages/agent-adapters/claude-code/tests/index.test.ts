import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import { ClaudeCodeAdapter, ClaudeCodeEventNormalizer, type ClaudeProcessHandle } from '../src/index.js';

const CLAUDE_STREAM_FIXTURE = [
  {
    type: 'system',
    subtype: 'init',
    session_id: 'claude_remote_99',
  },
  {
    type: 'assistant',
    session_id: 'claude_remote_99',
    message: {
      id: 'msg_1',
      content: [
        { type: 'thinking', thinking: '先检查代码结构' },
        { type: 'text', text: '正在执行测试' },
        {
          type: 'tool_use',
          id: 'toolu_bash_1',
          name: 'Bash',
          input: { command: 'pnpm test', apiKey: 'sk-secret' },
        },
      ],
    },
  },
  {
    type: 'user',
    session_id: 'claude_remote_99',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_bash_1',
          content: 'Tests passed',
          is_error: false,
        },
      ],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    session_id: 'claude_remote_99',
    is_error: false,
    total_cost_usd: 0.021,
    usage: { input_tokens: 900, output_tokens: 210 },
  },
];

describe('ClaudeCodeAdapter & ClaudeCodeEventNormalizer', () => {
  it('normalizes Claude Code stream-json lifecycle into Nienie canonical events', () => {
    const normalizer = new ClaudeCodeEventNormalizer({ machineId: 'mac_claude' });
    const events: CanonicalAgentEvent[] = [];

    for (const raw of CLAUDE_STREAM_FIXTURE) {
      events.push(...normalizer.normalize('ses_1', raw));
    }

    expect(events.map((e) => ({ seq: e.sequence, type: e.type, payload: e.payload }))).toEqual([
      { seq: 1, type: 'status', payload: { status: 'running', detail: 'Claude Code session initialized' } },
      { seq: 2, type: 'thinking_delta', payload: { delta: '先检查代码结构' } },
      { seq: 3, type: 'text_delta', payload: { delta: '正在执行测试' } },
      {
        seq: 4,
        type: 'tool_use',
        payload: {
          toolCallId: 'toolu_bash_1',
          name: 'Bash',
          input: { command: 'pnpm test', apiKey: '[REDACTED]' },
        },
      },
      {
        seq: 5,
        type: 'tool_result',
        payload: {
          toolCallId: 'toolu_bash_1',
          content: 'Tests passed',
          isError: false,
        },
      },
      {
        seq: 6,
        type: 'usage',
        payload: { inputTokens: 900, outputTokens: 210, costUsd: 0.021 },
      },
      { seq: 7, type: 'status', payload: { status: 'idle', detail: 'Claude Code turn completed' } },
    ]);
  });

  it('spawns claude stream-json process and resumes bound session_id on subsequent prompts', async () => {
    const spawnedArgs: string[][] = [];
    const adapter = new ClaudeCodeAdapter({
      detectVersion: async () => '1.0.24 (Claude Code)',
      spawnProcess: (args) => {
        spawnedArgs.push(args);
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        // 模拟 Node spawn 事件时序：spawn 先于数据/退出
        setTimeout(() => emitter.emit('spawn'), 0);
        setTimeout(() => {
          for (const item of CLAUDE_STREAM_FIXTURE) {
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
    expect(info.version).toBe('1.0.24');

    const session = await adapter.createSession({ title: 'Claude Test' });
    await adapter.sendMessage(session.id, 'first prompt');
    await adapter.waitForRun(session.id); // sendMessage=接受即返回；执行完成（thread 绑定）后才续发
    await adapter.sendMessage(session.id, 'second prompt');
    await adapter.waitForRun(session.id);

    // F5：已加载 session 并发第二条被启动占位拒绝（await 窗口不双 spawn）
    const pConcurrent = adapter.sendMessage(session.id, 'third prompt');
    await expect(adapter.sendMessage(session.id, 'fourth prompt')).rejects.toThrow(/运行中的任务/);
    await pConcurrent;
    await adapter.waitForRun(session.id);

    expect(spawnedArgs[0]).toEqual(['-p', '--output-format', 'stream-json', '--verbose', 'first prompt']);
    expect(spawnedArgs[1]).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--resume',
      'claude_remote_99',
      'second prompt',
    ]);
  });

  it('F5 spawn 失败释放启动占位可重发 + 未加载 session 并发拒绝', async () => {
    let mode: 'fail' | 'ok' = 'fail';
    const adapter = new ClaudeCodeAdapter({
      detectVersion: async () => '1.0.24 (Claude Code)',
      spawnProcess: (): ClaudeProcessHandle => {
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

    // spawn 失败 → 占位释放 → 可立即重发
    const s1 = await adapter.createSession({ title: 'F5B' });
    await expect(adapter.sendMessage(s1.id, 'boom')).rejects.toThrow(/ENOENT/);
    mode = 'ok';
    await adapter.sendMessage(s1.id, 'retry ok');
    await adapter.waitForRun(s1.id);

    // 未加载 session：loadSession await 窗口内并发第二条被拒绝
    const p1 = adapter.sendMessage('claude_unknown_f5', 'a');
    await expect(adapter.sendMessage('claude_unknown_f5', 'b')).rejects.toThrow(/运行中的任务/);
    await p1;
    await adapter.waitForRun('claude_unknown_f5');
  });
});
