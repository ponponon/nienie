import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import { PtyFallbackAdapter, stripAnsiSequences } from '../src/index.js';

describe('PtyFallbackAdapter', () => {
  it('declares honest fallback capabilities and strips ANSI escape sequences into text_delta events', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const emitter = new EventEmitter();

    const adapter = new PtyFallbackAdapter({
      spawnPty: () => ({
        stdin,
        stdout,
        kill() {
          emitter.emit('exit', 0);
        },
        onExit: (cb) => emitter.on('exit', cb),
      }),
    });

    const info = await adapter.detect();
    expect(info.available).toBe(true);
    expect(info.capabilities.toolCalls).toBe(false);
    expect(info.capabilities.thinking).toBe(false);

    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));

    const session = await adapter.createSession({ title: 'Fallback Shell' });
    await adapter.sendMessage(session.id, 'echo hello');
    stdout.write('\u001b[32mhello world\u001b[0m\n');
    await adapter.cancel(session.id);

    expect(stripAnsiSequences('\u001b[31mError\u001b[0m')).toBe('Error');
    expect(events[0]).toMatchObject({
      type: 'text_delta',
      payload: { delta: 'hello world\n' },
    });
    expect(events[1]).toMatchObject({
      type: 'status',
      payload: { status: 'idle' },
    });
  });
});
