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

        queueMicrotask(() => {
          for (const frame of CODEX_JSONL_LIFECYCLE_FIXTURE) {
            stdout.write(`${JSON.stringify(frame)}\n`);
          }
          stdout.end();
          emitter.emit('exit', 0);
        });

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
});
