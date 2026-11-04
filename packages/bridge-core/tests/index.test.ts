import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@nienie/agent-events';
import { AgentRegistry, SessionRouter } from '../src/index.js';

function adapter(id: 'opencode' | 'codex'): AgentAdapter {
  return {
    id,
    name: id,
    capabilities: {
      streaming: true,
      thinking: false,
      toolCalls: true,
      fileChanges: false,
      permissionRequests: false,
      modelSwitch: false,
      sessionResume: false,
      cancel: true,
    },
    async detect() { return { id, name: id, available: true, capabilities: this.capabilities }; },
    async listSessions() { return []; },
    async sendMessage() {},
    async cancel() {},
    async dispose() {},
    onEvent() { return () => {}; },
  };
}

describe('bridge core', () => {
  it('rejects duplicate adapters', () => {
    const registry = new AgentRegistry();
    registry.register(adapter('opencode'));
    expect(() => registry.register(adapter('opencode'))).toThrow('Agent adapter already registered: opencode');
  });

  it('routes a session command to its agent adapter', async () => {
    const registry = new AgentRegistry();
    const routed: string[] = [];
    const opencode = adapter('opencode');
    opencode.sendMessage = async (_sessionId, message) => { routed.push(message); };
    registry.register(opencode);
    await new SessionRouter(registry).sendMessage({
      id: 'session-1', agentId: 'opencode', title: 'Test', projectPath: '/tmp/project',
      status: 'idle', createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z',
    }, 'run tests');
    expect(routed).toEqual(['run tests']);
  });
});
