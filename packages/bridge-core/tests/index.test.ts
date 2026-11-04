import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@nienie/agent-events';
import type { AgentSession, CanonicalAgentEvent } from '@nienie/protocol';
import { AgentRegistry, SessionRouter } from '../src/index.js';

function adapter(id: 'opencode' | 'codex'): AgentAdapter & { emit(event: CanonicalAgentEvent): void } {
  const listeners = new Set<(event: CanonicalAgentEvent) => void>();
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
      sessionResume: true,
      cancel: true,
    },
    async detect() { return { id, name: id, available: true, capabilities: this.capabilities }; },
    async listSessions() { return []; },
    async createSession(input) {
      return {
        id: 'ses_new',
        agentId: id,
        title: input?.title ?? 'Untitled',
        projectPath: input?.projectPath ?? '/tmp/project',
        status: 'idle',
        createdAt: '2026-11-04T00:00:00Z',
        updatedAt: '2026-11-04T00:00:00Z',
      };
    },
    async loadSession(sessionId) {
      return {
        id: sessionId,
        agentId: id,
        title: 'Resumed Session',
        projectPath: '/tmp/project',
        status: 'idle',
        createdAt: '2026-11-04T00:00:00Z',
        updatedAt: '2026-11-04T00:00:00Z',
      };
    },
    async sendMessage() {},
    async cancel() {},
    async dispose() { listeners.clear(); },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
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

  it('creates and loads sessions through SessionRouter and forwards canonical events', async () => {
    const registry = new AgentRegistry();
    const opencode = adapter('opencode');
    registry.register(opencode);
    const router = new SessionRouter(registry);

    const created: AgentSession = await router.createSession('opencode', {
      title: 'Feature work',
      projectPath: '/workspace/app',
    });
    expect(created).toMatchObject({
      id: 'ses_new',
      agentId: 'opencode',
      title: 'Feature work',
      projectPath: '/workspace/app',
    });

    const loaded: AgentSession = await router.loadSession('opencode', 'ses_existing');
    expect(loaded).toMatchObject({
      id: 'ses_existing',
      agentId: 'opencode',
      title: 'Resumed Session',
    });

    const events: CanonicalAgentEvent[] = [];
    const unsubscribe = router.onEvent((event) => events.push(event));

    opencode.emit({
      version: 1,
      eventId: 'evt_1',
      agentId: 'opencode',
      sessionId: 'ses_existing',
      sequence: 1,
      timestamp: '2026-11-04T00:00:00Z',
      type: 'text_delta',
      payload: { delta: 'Hello Bridge' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ delta: 'Hello Bridge' });

    unsubscribe();
  });
});
