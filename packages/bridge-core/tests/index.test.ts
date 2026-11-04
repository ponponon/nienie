import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@nienie/agent-events';
import type { AgentSession, BridgeResponse, CanonicalAgentEvent } from '@nienie/protocol';
import {
  AgentRegistry,
  BridgeServer,
  HeadlessBridgeDaemon,
  PairingManager,
  PushNotificationRouter,
  RelayServer,
  SessionRouter,
  type PushNotificationMessage,
} from '../src/index.js';

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

  it('enforces one-time pairing codes, issues device credentials, rejects unauthorized requests, and revokes devices', async () => {
    let nowMs = Date.parse('2026-11-04T10:00:00.000Z');
    const pairingManager = new PairingManager({
      machineId: 'machine_secure',
      ttlMs: 60_000,
      now: () => new Date(nowMs),
    });

    const registry = new AgentRegistry();
    const opencode = adapter('opencode');
    const executedPrompts: string[] = [];
    opencode.sendMessage = async (_sessionId, message) => {
      executedPrompts.push(message);
    };
    registry.register(opencode);

    const server = new BridgeServer({
      registry,
      pairingManager,
      machineId: 'machine_secure',
      port: 0,
    });
    const { url } = await server.start();
    cleanups.push(() => server.stop());

    const unauthorizedClient = await connectWsClient(url);
    const mobileClient = await connectWsClient(url);
    cleanups.push(async () => {
      unauthorizedClient.close();
      mobileClient.close();
    });

    // 1. Unauthorized client cannot list sessions or send prompts
    const unauthSessions = await unauthorizedClient.request({
      type: 'sessions.list',
      requestId: 'req_unauth_1',
    });
    expect(unauthSessions).toEqual({
      type: 'response',
      requestId: 'req_unauth_1',
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Device authentication required',
      },
    });

    const unauthSend = await unauthorizedClient.request({
      type: 'session.send',
      requestId: 'req_unauth_2',
      sessionId: 'ses_seed_1',
      message: 'malicious command',
    });
    expect(unauthSend).toEqual({
      type: 'response',
      requestId: 'req_unauth_2',
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Device authentication required',
      },
    });
    expect(executedPrompts).toEqual([]);

    // 2. Generate one-time pairing code & QR payload
    const pairingChallenge = pairingManager.createPairingCode({ wsUrl: url });
    expect(pairingChallenge.qrUri.startsWith('nienie://pair?data=')).toBe(true);
    expect(pairingChallenge.pairingCode).toMatch(/^\d{6}$/);

    // 3. Mobile pairs using the one-time pairing code
    const pairRes = await mobileClient.request({
      type: 'pair.confirm',
      requestId: 'req_pair_ok',
      pairingCode: pairingChallenge.pairingCode,
      deviceName: 'Pon iPhone',
      platform: 'ios',
    });
    expect(pairRes.type).toBe('response');
    if (pairRes.type !== 'response' || !pairRes.ok) {
      throw new Error('Expected successful pair.confirm response');
    }
    const pairData = pairRes.data as {
      deviceId: string;
      deviceToken: string;
      machineId: string;
    };
    expect(pairData.machineId).toBe('machine_secure');
    expect(pairData.deviceId).toBeTruthy();
    expect(pairData.deviceToken.length).toBeGreaterThanOrEqual(32);

    // 4. Reusing the same one-time pairing code is rejected
    const reuseRes = await unauthorizedClient.request({
      type: 'pair.confirm',
      requestId: 'req_pair_reuse',
      pairingCode: pairingChallenge.pairingCode,
      deviceName: 'Attacker Phone',
    });
    expect(reuseRes).toEqual({
      type: 'response',
      requestId: 'req_pair_reuse',
      ok: false,
      error: {
        code: 'INVALID_PAIRING_CODE',
        message: 'Pairing code is invalid or expired',
      },
    });

    // 5. Expired pairing code is rejected
    const expiringChallenge = pairingManager.createPairingCode({ wsUrl: url });
    nowMs += 61_000;
    const expiredRes = await unauthorizedClient.request({
      type: 'pair.confirm',
      requestId: 'req_pair_expired',
      pairingCode: expiringChallenge.pairingCode,
      deviceName: 'Late Phone',
    });
    expect(expiredRes).toEqual({
      type: 'response',
      requestId: 'req_pair_expired',
      ok: false,
      error: {
        code: 'INVALID_PAIRING_CODE',
        message: 'Pairing code is invalid or expired',
      },
    });

    // 6. Paired mobile client can now send prompt and receive events
    const authedSend = await mobileClient.request({
      type: 'session.send',
      requestId: 'req_authed_send',
      sessionId: 'ses_seed_1',
      message: 'run tests safely',
    });
    expect(authedSend).toEqual({
      type: 'response',
      requestId: 'req_authed_send',
      ok: true,
      data: { accepted: true, sessionId: 'ses_seed_1' },
    });
    expect(executedPrompts).toEqual(['run tests safely']);

    // 7. Reconnecting with deviceToken in hello authenticates the new connection
    const reconnectedClient = await connectWsClient(url);
    cleanups.push(async () => reconnectedClient.close());

    const helloAuthRes = await reconnectedClient.request({
      type: 'hello',
      requestId: 'req_hello_token',
      protocolVersion: 1,
      deviceToken: pairData.deviceToken,
    });
    expect(helloAuthRes).toEqual({
      type: 'response',
      requestId: 'req_hello_token',
      ok: true,
      data: {
        protocolVersion: 1,
        machineId: 'machine_secure',
        authenticated: true,
        deviceId: pairData.deviceId,
      },
    });

    // 8. Revoking the device immediately blocks future commands and token reuse
    expect(pairingManager.revokeDevice(pairData.deviceId)).toBe(true);
    expect(
      pairingManager.listDevices().find((d) => d.deviceId === pairData.deviceId)?.revokedAt,
    ).toBeTruthy();

    const afterRevokeRes = await reconnectedClient.request({
      type: 'agents.list',
      requestId: 'req_after_revoke',
    });
    expect(afterRevokeRes).toEqual({
      type: 'response',
      requestId: 'req_after_revoke',
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Device authentication required',
      },
    });
  });

  it('replays missed events by sequence, provides machine/session snapshots, routes permission approvals, and blocks unauthorized approvals', async () => {
    const pairingManager = new PairingManager({ machineId: 'machine_reliable' });
    const registry = new AgentRegistry();
    const opencode = adapter('opencode');
    const approvalDecisions: Array<{ sessionId: string; permissionId: string; decision: string }> = [];

    opencode.replyPermission = async (sessionId, permissionId, decision) => {
      approvalDecisions.push({ sessionId, permissionId, decision });
    };
    registry.register(opencode);

    const server = new BridgeServer({
      registry,
      pairingManager,
      machineId: 'machine_reliable',
      port: 0,
    });
    const { url } = await server.start();
    cleanups.push(() => server.stop());

    const unauthClient = await connectWsClient(url);
    const authedClient = await connectWsClient(url);
    cleanups.push(async () => {
      unauthClient.close();
      authedClient.close();
    });

    // 1. Unauthorized client cannot send permission approval
    const unauthPerm = await unauthClient.request({
      type: 'permission.reply',
      requestId: 'req_unauth_perm',
      sessionId: 'ses_seed_1',
      permissionId: 'perm_1',
      decision: 'allow_once',
    });
    expect(unauthPerm).toEqual({
      type: 'response',
      requestId: 'req_unauth_perm',
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Device authentication required',
      },
    });
    expect(approvalDecisions).toEqual([]);

    // 2. Authenticate mobile device
    const challenge = pairingManager.createPairingCode({ wsUrl: url });
    await authedClient.request({
      type: 'pair.confirm',
      requestId: 'req_pair_rel',
      pairingCode: challenge.pairingCode,
      deviceName: 'Reliable Phone',
    });

    // 3. Emit 3 events for ses_seed_1 and verify events.replay afterSequence=1 returns sequences 2 and 3
    for (let seq = 1; seq <= 3; seq++) {
      opencode.emit({
        version: 1,
        eventId: `evt_rel_${seq}`,
        agentId: 'opencode',
        sessionId: 'ses_seed_1',
        sequence: seq,
        timestamp: '2026-11-04T10:00:00Z',
        type: 'text_delta',
        payload: { delta: `chunk_${seq}` },
      });
    }

    const replayRes = await authedClient.request({
      type: 'events.replay',
      requestId: 'req_replay',
      sessionId: 'ses_seed_1',
      afterSequence: 1,
    });
    expect(replayRes).toMatchObject({
      type: 'response',
      requestId: 'req_replay',
      ok: true,
      data: {
        sessionId: 'ses_seed_1',
        latestSequence: 3,
        events: [
          { sequence: 2, payload: { delta: 'chunk_2' } },
          { sequence: 3, payload: { delta: 'chunk_3' } },
        ],
      },
    });

    // 4. machine.get and session.state snapshots
    const machineSnap = await authedClient.request({
      type: 'machine.get',
      requestId: 'req_machine_snap',
    });
    expect(machineSnap).toMatchObject({
      type: 'response',
      requestId: 'req_machine_snap',
      ok: true,
      data: {
        machineId: 'machine_reliable',
        protocolVersion: 1,
        agents: [{ id: 'opencode', available: true }],
      },
    });

    const sessionState = await authedClient.request({
      type: 'session.state',
      requestId: 'req_ses_state',
      sessionId: 'ses_seed_1',
    });
    expect(sessionState).toMatchObject({
      type: 'response',
      requestId: 'req_ses_state',
      ok: true,
      data: {
        session: { id: 'ses_seed_1', agentId: 'opencode' },
        latestSequence: 3,
        bufferedEventCount: 3,
      },
    });

    // 5. Authorized permission approval succeeds
    const permRes = await authedClient.request({
      type: 'permission.reply',
      requestId: 'req_authed_perm',
      sessionId: 'ses_seed_1',
      permissionId: 'perm_1',
      decision: 'allow_once',
    });
    expect(permRes).toEqual({
      type: 'response',
      requestId: 'req_authed_perm',
      ok: true,
      data: {
        replied: true,
        sessionId: 'ses_seed_1',
        permissionId: 'perm_1',
        decision: 'allow_once',
      },
    });
    expect(approvalDecisions).toEqual([
      { sessionId: 'ses_seed_1', permissionId: 'perm_1', decision: 'allow_once' },
    ]);
  });

  it('runs in headless Linux/server daemon mode without Electron UI and connects outbound to Relay', async () => {
    const relayServer = new RelayServer({ port: 0 });
    const { url: relayUrl } = await relayServer.start();
    cleanups.push(() => relayServer.stop());

    const daemon = new HeadlessBridgeDaemon({
      machineId: 'linux_headless_box',
      adapters: [adapter('opencode')],
      enableRelay: true,
      relayUrl,
    });
    cleanups.push(() => daemon.stop());

    const status = await daemon.start();
    expect(status.machineId).toBe('linux_headless_box');
    expect(status.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(status.relayUrl).toBe(relayUrl);
    expect(status.pairingCode).toMatch(/^\d{6}$/);
    expect(status.qrUri).toContain('nienie://pair?data=');
    expect(status.agents).toEqual([
      expect.objectContaining({ id: 'opencode', available: true }),
    ]);

    const client = await connectWsClient(status.wsUrl);
    cleanups.push(async () => client.close());

    const pairRes = await client.request({
      type: 'pair.confirm',
      requestId: 'req_headless_pair',
      pairingCode: status.pairingCode,
      deviceName: 'Headless CLI Client',
    });
    expect(pairRes).toMatchObject({
      type: 'response',
      requestId: 'req_headless_pair',
      ok: true,
    });
  });

  it('registers mobile push tokens and dispatches redacted iOS/Android notifications when mobile is offline', async () => {
    const dispatched: PushNotificationMessage[] = [];
    const pushRouter = new PushNotificationRouter({
      sender: async (notification) => {
        dispatched.push(notification);
      },
    });

    const pairingManager = new PairingManager({ machineId: 'machine_push' });
    const registry = new AgentRegistry();
    const opencode = adapter('opencode');
    registry.register(opencode);

    const server = new BridgeServer({
      registry,
      pairingManager,
      pushRouter,
      machineId: 'machine_push',
      port: 0,
    });
    const { url } = await server.start();
    cleanups.push(() => server.stop());

    const client = await connectWsClient(url);
    cleanups.push(async () => client.close());

    // Pair first
    const challenge = pairingManager.createPairingCode({ wsUrl: url });
    await client.request({
      type: 'pair.confirm',
      requestId: 'req_pair_push',
      pairingCode: challenge.pairingCode,
      deviceName: 'Push iPhone',
      platform: 'ios',
    });

    // Register push token
    const regRes = await client.request({
      type: 'push.register',
      requestId: 'req_push_reg',
      platform: 'ios',
      provider: 'apns',
      pushToken: 'apns_tok_abc',
    });
    expect(regRes).toMatchObject({
      type: 'response',
      requestId: 'req_push_reg',
      ok: true,
      data: { registered: true, provider: 'apns' },
    });

    // Disconnect mobile client so Bridge sees 0 connected clients (offline)
    client.close();
    await waitFor(() => server.getConnectedClientCount() === 0);

    // Emit waiting permission event and error event with sensitive secret
    opencode.emit({
      version: 1,
      eventId: 'evt_push_1',
      agentId: 'opencode',
      sessionId: 'ses_seed_1',
      sequence: 1,
      timestamp: '2026-11-04T10:00:00Z',
      type: 'status',
      payload: {
        status: 'waiting',
        detail: 'Permission requested: bash',
      },
    });
    opencode.emit({
      version: 1,
      eventId: 'evt_push_2',
      agentId: 'opencode',
      sessionId: 'ses_seed_1',
      sequence: 2,
      timestamp: '2026-11-04T10:00:01Z',
      type: 'error',
      payload: {
        code: 'APIError',
        message: 'Failed with key=sk-secret999',
      },
    });

    await waitFor(() => dispatched.length === 2);
    expect(dispatched[0]).toMatchObject({
      platform: 'ios',
      provider: 'apns',
      pushToken: 'apns_tok_abc',
      title: 'Nienie Permission Needed',
      body: 'Permission requested: bash',
    });
    expect(dispatched[1]?.body).not.toContain('sk-secret999');
    expect(dispatched[1]?.body).toContain('[REDACTED]');
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
