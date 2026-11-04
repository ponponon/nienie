import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAY_URL, PROTOCOL_VERSION, resolveRelayUrl } from '../src/index.js';

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
});
