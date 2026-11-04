import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/index.js';

describe('protocol', () => {
  it('keeps the first wire protocol version stable', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
