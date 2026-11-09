import { describe, expect, it } from 'vitest';
import { OpenCodeEventNormalizer } from '../src/normalizer.js';
import { generateStreamEpoch } from '@nienie/agent-events';

describe('事件流 streamEpoch', () => {
  it('normalizer 为每个事件盖 streamEpoch，同一实例共享、不同实例不同', () => {
    const nrmA = new OpenCodeEventNormalizer({ agentId: 'opencode', machineId: 'm' });
    const nrmB = new OpenCodeEventNormalizer({ agentId: 'opencode', machineId: 'm' });

    const raw = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_1',
        messageID: 'msg_1',
        partID: 'prt_1',
        field: 'text',
        delta: 'hello',
      },
    };

    const evA1 = nrmA.normalize(raw)[0]!;
    const evA2 = nrmA.normalize({ ...raw, properties: { ...raw.properties, delta: ' world' } })[0]!;
    const evB = nrmB.normalize(raw)[0]!;

    // 同一 normalizer 的事件共享同一 epoch
    expect(evA1.streamEpoch).toBeTruthy();
    expect(evA1.streamEpoch).toBe(evA2.streamEpoch);
    // 不同 normalizer（不同事件流实例）epoch 不同
    expect(evB.streamEpoch).not.toBe(evA1.streamEpoch);
  });

  it('generateStreamEpoch 生成唯一标识', () => {
    const e1 = generateStreamEpoch();
    const e2 = generateStreamEpoch();
    expect(e1).not.toBe(e2);
    expect(e1.startsWith('epoch_')).toBe(true);
  });

  it('历史回放事件 eventId 稳定（history:sid:part:rev），供客户端幂等去重', async () => {
    // 直接验证 emitTextDelta 的 eventId 格式（通过事件产出）
    const { OpenCodeAdapter } = await import('../src/index.js');
    // 只验证格式约定，不依赖真实 DB：调用私有 emitTextDelta 经由 (adapter as any)
    const adapter = new OpenCodeAdapter({ baseUrl: 'http://127.0.0.1:1' });
    const events: Array<{ eventId: string; streamEpoch: string }> = [];
    adapter.onEvent((e) => events.push({ eventId: e.eventId, streamEpoch: e.streamEpoch }));
    (adapter as unknown as { emitTextDelta: (...a: unknown[]) => void }).emitTextDelta(
      'ses_x',
      'prt_9',
      11,
      'full text',
      undefined,
    );
    expect(events[0]!.eventId).toBe('history:ses_x:prt_9:11');
    expect(events[0]!.streamEpoch).toBeTruthy();
    await adapter.dispose();
  });
});
