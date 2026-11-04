import { describe, expect, it } from 'vitest';
import { createAgentInfo } from '../src/index.js';

describe('agent event contracts', () => {
  it('creates stable agent metadata from an adapter', () => {
    const info = createAgentInfo(
      {
        id: 'opencode',
        name: 'OpenCode',
        capabilities: {
          streaming: true,
          thinking: true,
          toolCalls: true,
          fileChanges: true,
          permissionRequests: true,
          modelSwitch: true,
          sessionResume: true,
          cancel: true,
        },
      },
      false,
    );

    expect(info).toMatchObject({ id: 'opencode', available: false });
  });
});
