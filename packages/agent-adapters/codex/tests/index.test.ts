import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/index.js';

describe('CodexAdapter', () => {
  it('exposes the MVP Codex identity and capabilities', async () => {
    const info = await new CodexAdapter().detect();
    expect(info.id).toBe('codex');
    expect(info.name).toBe('Codex');
    expect(info.available).toBe(false);
    expect(info.capabilities.streaming).toBe(true);
    expect(info.capabilities.cancel).toBe(true);
  });
});
