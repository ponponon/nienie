import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELAY_URL,
  parseBridgeRequest,
  PROTOCOL_VERSION,
  resolveRelayUrl,
} from '../src/index.js';

describe('protocol', () => {
  it('keeps the first wire protocol version stable', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('uses the public default relay endpoint', () => {
    expect(DEFAULT_RELAY_URL).toBe('wss://nienie-replay.quniv.cn');
    expect(resolveRelayUrl()).toBe(DEFAULT_RELAY_URL);
  });

  it('allows users to replace the default relay endpoint', () => {
    expect(resolveRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com');
    expect(resolveRelayUrl('')).toBe(DEFAULT_RELAY_URL);
  });

  it('validates incoming BridgeRequest payloads and rejects malformed or unsupported versions', () => {
    const validHello = parseBridgeRequest(
      JSON.stringify({ type: 'hello', requestId: 'req_1', protocolVersion: 1 }),
    );
    expect(validHello).toEqual({
      ok: true,
      request: { type: 'hello', requestId: 'req_1', protocolVersion: 1 },
    });

    const wrongVersion = parseBridgeRequest(
      JSON.stringify({ type: 'hello', requestId: 'req_2', protocolVersion: 99 }),
    );
    expect(wrongVersion).toEqual({
      ok: false,
      requestId: 'req_2',
      error: {
        code: 'UNSUPPORTED_PROTOCOL_VERSION',
        message: 'Unsupported protocol version: 99',
      },
    });

    const oversized = parseBridgeRequest(
      JSON.stringify({ type: 'agents.list', requestId: 'req_3' }),
      10,
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error.code).toBe('MESSAGE_TOO_LARGE');
    }
  });
});
