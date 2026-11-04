import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@nienie/agent-events';
import type { AgentSession, BridgeResponse, CanonicalAgentEvent } from '@nienie/protocol';
import { AgentRegistry, BridgeServer, SessionRouter } from '../src/index.js';

function adapter(id: 'opencode' | 'codex'): AgentAdapter & { emit(event: CanonicalAgentEvent): void } {
  const listeners = new Set<(event: CanonicalAgentEvent) => void>();
  const sessions = new Map<string, AgentSession>([
    [
      'ses_seed_1',
      {
        id: 'ses_seed_1',
        agentId: id,
        title: 'Seed Session',
        projectPath: '/tmp/project',
        status: 'idle',
        createdAt: '2026-11-04T00:00:00Z',
        updatedAt: '2026-11-04T00:00:00Z',
      },
    ],
  ]);

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
    async listSessions() { return [...sessions.values()]; },
    async createSession(input) {
      const created: AgentSession = {
        id: 'ses_new',
        agentId: id,
        title: input?.title ?? 'Untitled',
        projectPath: input?.projectPath ?? '/tmp/project',
        status: 'idle',
        createdAt: '2026-11-04T00:00:00Z',
        updatedAt: '2026-11-04T00:00:00Z',
      };
      sessions.set(created.id, created);
      return created;
    },
    async loadSession(sessionId) {
      const loaded: AgentSession = {
        id: sessionId,
        agentId: id,
        title: 'Resumed Session',
        projectPath: '/tmp/project',
        status: 'idle',
        createdAt: '2026-11-04T00:00:00Z',
        updatedAt: '2026-11-04T00:00:00Z',
      };
      sessions.set(loaded.id, loaded);
      return loaded;
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
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

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

  it('serves WebSocket requests for agents, sessions, message forwarding, event broadcast, and disconnect cleanup', async () => {
    const registry = new AgentRegistry();
    const opencode = adapter('opencode');
    const forwardedMessages: Array<{ sessionId: string; message: string }> = [];
    const cancelledSessions: string[] = [];

    opencode.sendMessage = async (sessionId, message) => {
      forwardedMessages.push({ sessionId, message });
    };
    opencode.cancel = async (sessionId) => {
      cancelledSessions.push(sessionId);
    };
    registry.register(opencode);

    const server = new BridgeServer({
      registry,
      machineId: 'machine_ws_test',
      port: 0,
      heartbeatIntervalMs: 100,
      clientTimeoutMs: 500,
    });
    const { url } = await server.start();
    cleanups.push(() => server.stop());

    const clientA = await connectWsClient(url);
    const clientB = await connectWsClient(url);
    cleanups.push(async () => {
      clientA.close();
      clientB.close();
    });

    expect(server.getConnectedClientCount()).toBe(2);

    // 1. hello
    const helloRes = await clientA.request({
      type: 'hello',
      requestId: 'req_hello',
      protocolVersion: 1,
    });
    expect(helloRes).toEqual({
      type: 'response',
      requestId: 'req_hello',
      ok: true,
      data: {
        protocolVersion: 1,
        machineId: 'machine_ws_test',
      },
    });

    // 2. agents.list
    const agentsRes = await clientA.request({
      type: 'agents.list',
      requestId: 'req_agents',
    });
    expect(agentsRes).toMatchObject({
      type: 'response',
      requestId: 'req_agents',
      ok: true,
      data: {
        agents: [{ id: 'opencode', available: true }],
      },
    });

    // 3. sessions.list
    const sessionsRes = await clientA.request({
      type: 'sessions.list',
      requestId: 'req_sessions',
    });
    expect(sessionsRes).toMatchObject({
      type: 'response',
      requestId: 'req_sessions',
      ok: true,
      data: {
        sessions: [{ id: 'ses_seed_1', agentId: 'opencode', title: 'Seed Session' }],
      },
    });

    // 4. session.create
    const createRes = await clientA.request({
      type: 'session.create',
      requestId: 'req_create',
      agentId: 'opencode',
      input: { title: 'Created via WS', projectPath: '/workspace/ws' },
    });
    expect(createRes).toMatchObject({
      type: 'response',
      requestId: 'req_create',
      ok: true,
      data: {
        session: { id: 'ses_new', title: 'Created via WS' },
      },
    });

    // 5. session.send
    const sendRes = await clientA.request({
      type: 'session.send',
      requestId: 'req_send',
      sessionId: 'ses_new',
      message: 'fix tests',
    });
    expect(sendRes).toEqual({
      type: 'response',
      requestId: 'req_send',
      ok: true,
      data: { accepted: true, sessionId: 'ses_new' },
    });
    expect(forwardedMessages).toEqual([{ sessionId: 'ses_new', message: 'fix tests' }]);

    // 6. session.send to missing session returns SESSION_NOT_FOUND
    const missingRes = await clientA.request({
      type: 'session.send',
      requestId: 'req_missing',
      sessionId: 'ses_does_not_exist',
      message: 'hello',
    });
    expect(missingRes).toEqual({
      type: 'response',
      requestId: 'req_missing',
      ok: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found: ses_does_not_exist',
      },
    });

    // 7. session.cancel
    const cancelRes = await clientA.request({
      type: 'session.cancel',
      requestId: 'req_cancel',
      sessionId: 'ses_new',
    });
    expect(cancelRes).toEqual({
      type: 'response',
      requestId: 'req_cancel',
      ok: true,
      data: { cancelled: true, sessionId: 'ses_new' },
    });
    expect(cancelledSessions).toEqual(['ses_new']);

    // 8. Event broadcast to all connected clients
    opencode.emit({
      version: 1,
      eventId: 'evt_broadcast_1',
      agentId: 'opencode',
      sessionId: 'ses_new',
      sequence: 1,
      timestamp: '2026-11-04T00:00:00Z',
      type: 'text_delta',
      payload: { delta: 'Broadcasted text' },
    });

    const [eventA, eventB] = await Promise.all([clientA.nextEvent(), clientB.nextEvent()]);
    expect(eventA).toMatchObject({
      type: 'session.event',
      event: { eventId: 'evt_broadcast_1', payload: { delta: 'Broadcasted text' } },
    });
    expect(eventB).toMatchObject({
      type: 'session.event',
      event: { eventId: 'evt_broadcast_1', payload: { delta: 'Broadcasted text' } },
    });

    // 9. Disconnect cleanup
    clientB.close();
    await waitFor(() => server.getConnectedClientCount() === 1);
    clientA.close();
    await waitFor(() => server.getConnectedClientCount() === 0);
  });
});

async function connectWsClient(url: string) {
  const ws = new WebSocket(url);
  const pendingResponses = new Map<string, (msg: BridgeResponse) => void>();
  const eventQueue: BridgeResponse[] = [];
  const eventWaiters: Array<(msg: BridgeResponse) => void> = [];

  ws.addEventListener('message', (ev) => {
    const parsed = JSON.parse(String(ev.data)) as BridgeResponse;
    if (parsed.type === 'response') {
      const resolver = pendingResponses.get(parsed.requestId);
      if (resolver) {
        pendingResponses.delete(parsed.requestId);
        resolver(parsed);
      }
    } else if (parsed.type === 'session.event') {
      const waiter = eventWaiters.shift();
      if (waiter) {
        waiter(parsed);
      } else {
        eventQueue.push(parsed);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (err) => reject(err), { once: true });
  });

  return {
    request(payload: Record<string, unknown>): Promise<BridgeResponse> {
      const requestId = String(payload.requestId);
      return new Promise<BridgeResponse>((resolve) => {
        pendingResponses.set(requestId, resolve);
        ws.send(JSON.stringify(payload));
      });
    },
    nextEvent(): Promise<BridgeResponse> {
      const queued = eventQueue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<BridgeResponse>((resolve) => {
        eventWaiters.push(resolve);
      });
    },
    close() {
      ws.close();
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for condition');
}
