import { describe, expect, it } from 'vitest';
import { createBridgeRegistry } from '../src/bridge.js';

describe('desktop bridge composition', () => {
  it('registers the MVP agents', async () => {
    const agents = await createBridgeRegistry().detectAll();
    expect(agents.map((agent) => agent.id)).toEqual(['opencode', 'codex']);
  });
});
