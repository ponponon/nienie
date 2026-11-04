import { describe, expect, it } from 'vitest';
import { OpenCodeAdapter } from '../src/index.js';

describe('OpenCodeAdapter', () => {
  it('exposes the MVP OpenCode identity and capabilities', async () => {
    const info = await new OpenCodeAdapter().detect();
    expect(info.id).toBe('opencode');
    expect(info.name).toBe('OpenCode');
    expect(info.available).toBe(false);
    expect(info.capabilities.streaming).toBe(true);
    expect(info.capabilities.sessionResume).toBe(true);
  });
});
