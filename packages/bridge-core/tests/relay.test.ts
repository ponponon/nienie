import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@nienie/agent-events';
import {
  decryptRelayPayload,
  DEFAULT_RELAY_URL,
  encryptRelayPayload,
  type CanonicalAgentEvent,
} from '@nienie/protocol';
import {
  AgentRegistry,
  BridgeRelayClient,
  BridgeServer,
  RelayServer,
  runDaemonCli,
  runRelayCli,
} from '../src/index.js';

function createTestAdapter(): AgentAdapter & { emit(event: CanonicalAgentEvent): void } {
  const listeners = new Set<(event: CanonicalAgentEvent) => void>();
  return {
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
    async detect() {
      return { id: 'opencode', name: 'OpenCode', available: true, version: '0.15.2', capabilities: this.capabilities };
    },
    async listSessions() {
      return [
        {
          id: 'ses_relay_1',
          agentId: 'opencode',
          title: 'Relay Session',
          projectPath: '/workspace/nienie',
          status: 'idle',
          createdAt: '2026-11-04T00:00:00Z',
          updatedAt: '2026-11-04T00:00:00Z',
        },
      ];
    },
    async sendMessage() {},
    async cancel() {},
    async dispose() {
      listeners.clear();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe('Public Relay server and outbound Bridge/Mobile routing', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('defaults to wss://nienie-replay.quniv.cn and allows user replacement', () => {
    const registry = new AgentRegistry();
    const bridgeServer = new BridgeServer({ registry, machineId: 'machine_1' });

    const defaultClient = new BridgeRelayClient({
      machineId: 'machine_1',
      bridgeServer,
    });
    expect(defaultClient.relayUrl).toBe(DEFAULT_RELAY_URL);

    const customClient = new BridgeRelayClient({
      machineId: 'machine_1',
      bridgeServer,
      relayUrl: 'wss://my-custom-relay.example.com',
    });
    expect(customClient.relayUrl).toBe('wss://my-custom-relay.example.com');
  });

  it('routes encrypted messages, tracks online status, broadcasts events, and auto-reconnects over Relay', async () => {
    const relayServer = new RelayServer({ port: 0 });
    const { url: relayUrl } = await relayServer.start();
    cleanups.push(() => relayServer.stop());

    const registry = new AgentRegistry();
    const opencode = createTestAdapter();
    const receivedPrompts: string[] = [];
    opencode.sendMessage = async (_sessionId, msg) => {
      receivedPrompts.push(msg);
    };
    registry.register(opencode);

    const bridgeServer = new BridgeServer({
      registry,
      machineId: 'machine_relay_target',
    });

    const sharedSecret = 'e2ee_shared_secret_key_01';

    // 1. Mobile connects outbound to Relay before Bridge is online
    const mobileWs = new WebSocket(relayUrl);
    const mobileInbox: Array<Record<string, unknown>> = [];
    mobileWs.addEventListener('message', (ev) => {
      mobileInbox.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });
    await new Promise<void>((resolve) => mobileWs.addEventListener('open', () => resolve(), { once: true }));
    cleanups.push(async () => mobileWs.close());

    mobileWs.send(
      JSON.stringify({
        type: 'relay.register',
        role: 'mobile',
        machineId: 'machine_relay_target',
        clientId: 'mob_client_1',
      }),
    );

    await waitFor(() => mobileInbox.some((m) => m.type === 'relay.registered'));
    expect(mobileInbox.find((m) => m.type === 'relay.registered')).toMatchObject({
      type: 'relay.registered',
      machineId: 'machine_relay_target',
      bridgeOnline: false,
    });

    // 2. Bridge connects outbound to Relay -> Mobile receives online presence notification
    const bridgeRelay = new BridgeRelayClient({
      machineId: 'machine_relay_target',
      bridgeServer,
      relayUrl,
      sharedSecret,
      reconnectDelayMs: 40,
    });
    await bridgeRelay.connect();
    cleanups.push(() => bridgeRelay.close());

    await waitFor(() =>
      mobileInbox.some((m) => m.type === 'relay.presence' && m.bridgeOnline === true),
    );

    // 3. Mobile sends an E2EE encrypted command through Relay to Bridge
    const encryptedReq = encryptRelayPayload(
      JSON.stringify({
        type: 'session.send',
        requestId: 'req_relay_send_1',
        sessionId: 'ses_relay_1',
        message: 'hello over encrypted relay',
      }),
      sharedSecret,
    );

    mobileWs.send(
      JSON.stringify({
        type: 'relay.forward',
        machineId: 'machine_relay_target',
        fromClientId: 'mob_client_1',
        encrypted: encryptedReq,
      }),
    );

    await waitFor(() =>
      mobileInbox.some((m) => m.type === 'relay.forward' && m.encrypted !== undefined),
    );
    expect(receivedPrompts).toEqual(['hello over encrypted relay']);

    const forwardReply = mobileInbox.find(
      (m) => m.type === 'relay.forward' && m.encrypted !== undefined,
    )!;
    const decryptedReply = JSON.parse(
      decryptRelayPayload(
        forwardReply.encrypted as ReturnType<typeof encryptRelayPayload>,
        sharedSecret,
      ),
    );
    expect(decryptedReply).toEqual({
      type: 'response',
      requestId: 'req_relay_send_1',
      ok: true,
      data: { accepted: true, sessionId: 'ses_relay_1' },
    });

    // 4. Bridge emits CanonicalAgentEvent -> encrypted and forwarded via Relay to Mobile
    mobileInbox.length = 0;
    opencode.emit({
      version: 1,
      eventId: 'evt_relay_stream_1',
      agentId: 'opencode',
      sessionId: 'ses_relay_1',
      sequence: 1,
      timestamp: '2026-11-04T10:00:00Z',
      type: 'text_delta',
      payload: { delta: 'Encrypted streaming delta' },
    });

    await waitFor(() => mobileInbox.some((m) => m.type === 'relay.forward'));
    const eventEnvelope = mobileInbox.find((m) => m.type === 'relay.forward')!;
    const decryptedEvent = JSON.parse(
      decryptRelayPayload(
        eventEnvelope.encrypted as ReturnType<typeof encryptRelayPayload>,
        sharedSecret,
      ),
    );
    expect(decryptedEvent).toMatchObject({
      type: 'session.event',
      event: {
        eventId: 'evt_relay_stream_1',
        payload: { delta: 'Encrypted streaming delta' },
      },
    });

    // 5. Simulate Bridge drop -> Mobile sees bridgeOnline=false -> Bridge auto-reconnects -> bridgeOnline=true
    mobileInbox.length = 0;
    relayServer.disconnectBridge('machine_relay_target');

    await waitFor(() =>
      mobileInbox.some((m) => m.type === 'relay.presence' && m.bridgeOnline === false),
    );
    await waitFor(() =>
      mobileInbox.some((m) => m.type === 'relay.presence' && m.bridgeOnline === true),
    );
  });

  it('starts standalone Relay and Headless Daemon via CLI runners', async () => {
    const relayCli = await runRelayCli(['--host=127.0.0.1', '--port=0']);
    cleanups.push(() => relayCli.stop());
    expect(relayCli.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

    const daemonCli = await runDaemonCli([
      '--machine-id=cli_daemon_box',
      '--host=127.0.0.1',
      '--port=0',
      `--relay-url=${relayCli.url}`,
    ]);
    cleanups.push(() => daemonCli.stop());

    expect(daemonCli.status.machineId).toBe('cli_daemon_box');
    expect(daemonCli.status.relayUrl).toBe(relayCli.url);
    expect(daemonCli.status.pairingCode).toMatch(/^\d{6}$/);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for condition');
}
