import { describe, expect, it } from 'vitest';
import {
  decodePairingQrPayload,
  decryptRelayPayload,
  DEFAULT_RELAY_URL,
  encodePairingQrPayload,
  encryptRelayPayload,
  parseBridgeRequest,
  PROTOCOL_VERSION,
  resolveRelayUrl,
} from '../src/index.js';

describe('protocol', () => {
  it('keeps the first wire protocol version stable', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('uses the public default relay endpoint', () => {
    expect(DEFAULT_RELAY_URL).toBe('wss://nienie-replay.quniv.cn');
    expect(resolveRelayUrl()).toBe(DEFAULT_RELAY_URL);
  });

  it('allows users to replace the default relay endpoint', () => {
    expect(resolveRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com');
    expect(resolveRelayUrl('')).toBe(DEFAULT_RELAY_URL);
  });

  it('validates incoming BridgeRequest payloads and rejects malformed or unsupported versions', () => {
    const validHello = parseBridgeRequest(
      JSON.stringify({ type: 'hello', requestId: 'req_1', protocolVersion: 1 }),
    );
    expect(validHello).toEqual({
      ok: true,
      request: { type: 'hello', requestId: 'req_1', protocolVersion: 1 },
    });

    const wrongVersion = parseBridgeRequest(
      JSON.stringify({ type: 'hello', requestId: 'req_2', protocolVersion: 99 }),
    );
    expect(wrongVersion).toEqual({
      ok: false,
      requestId: 'req_2',
      error: {
        code: 'UNSUPPORTED_PROTOCOL_VERSION',
        message: 'Unsupported protocol version: 99',
      },
    });

    const oversized = parseBridgeRequest(
      JSON.stringify({ type: 'agents.list', requestId: 'req_3' }),
      10,
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error.code).toBe('MESSAGE_TOO_LARGE');
    }

    const pairConfirm = parseBridgeRequest(
      JSON.stringify({
        type: 'pair.confirm',
        requestId: 'req_pair_1',
        pairingCode: '123456',
        deviceName: 'iPhone 17 Pro',
        platform: 'ios',
      }),
    );
    expect(pairConfirm).toEqual({
      ok: true,
      request: {
        type: 'pair.confirm',
        requestId: 'req_pair_1',
        pairingCode: '123456',
        deviceName: 'iPhone 17 Pro',
        platform: 'ios',
      },
    });
  });

  it('encodes and decodes one-time pairing QR payloads without long-lived secrets', () => {
    const payload = {
      version: 1 as const,
      machineId: 'machine_mac',
      wsUrl: 'ws://192.168.1.10:4100',
      relayUrl: DEFAULT_RELAY_URL,
      pairingCode: '849201',
      expiresAt: '2026-11-04T12:05:00.000Z',
    };

    const uri = encodePairingQrPayload(payload);
    expect(uri.startsWith('nienie://pair?data=')).toBe(true);
    expect(decodePairingQrPayload(uri)).toEqual(payload);
  });

  it('encrypts and decrypts end-to-end Relay payloads with AES-256-GCM and rejects tampering', () => {
    const secret = 'ntk_shared_device_secret_key';
    const plaintext = JSON.stringify({
      type: 'session.send',
      requestId: 'req_e2ee_1',
      sessionId: 'ses_1',
      message: 'top secret prompt',
    });

    const box = encryptRelayPayload(plaintext, secret);
    expect(box.ciphertext).not.toContain('top secret prompt');
    expect(decryptRelayPayload(box, secret)).toBe(plaintext);

    expect(() => decryptRelayPayload(box, 'wrong_secret')).toThrow();
  });

  it('validates reliability and security commands: events.replay, machine.get, session.state, and permission.reply', () => {
    const replayReq = parseBridgeRequest(
      JSON.stringify({
        type: 'events.replay',
        requestId: 'req_replay_1',
        sessionId: 'ses_1',
        afterSequence: 3,
      }),
    );
    expect(replayReq).toEqual({
      ok: true,
      request: {
        type: 'events.replay',
        requestId: 'req_replay_1',
        sessionId: 'ses_1',
        afterSequence: 3,
      },
    });

    const machineReq = parseBridgeRequest(
      JSON.stringify({ type: 'machine.get', requestId: 'req_machine_1' }),
    );
    expect(machineReq).toEqual({
      ok: true,
      request: { type: 'machine.get', requestId: 'req_machine_1' },
    });

    const stateReq = parseBridgeRequest(
      JSON.stringify({
        type: 'session.state',
        requestId: 'req_state_1',
        sessionId: 'ses_1',
      }),
    );
    expect(stateReq).toEqual({
      ok: true,
      request: {
        type: 'session.state',
        requestId: 'req_state_1',
        sessionId: 'ses_1',
      },
    });

    const permReq = parseBridgeRequest(
      JSON.stringify({
        type: 'permission.reply',
        requestId: 'req_perm_1',
        sessionId: 'ses_1',
        permissionId: 'perm_99',
        decision: 'allow_once',
      }),
    );
    expect(permReq).toEqual({
      ok: true,
      request: {
        type: 'permission.reply',
        requestId: 'req_perm_1',
        sessionId: 'ses_1',
        permissionId: 'perm_99',
        decision: 'allow_once',
      },
    });

    const modelsReq = parseBridgeRequest(
      JSON.stringify({
        type: 'models.list',
        requestId: 'req_models_1',
        agentId: 'opencode',
      }),
    );
    expect(modelsReq).toEqual({
      ok: true,
      request: {
        type: 'models.list',
        requestId: 'req_models_1',
        agentId: 'opencode',
      },
    });

    const diffReq = parseBridgeRequest(
      JSON.stringify({
        type: 'session.diff',
        requestId: 'req_diff_1',
        sessionId: 'ses_alpha',
      }),
    );
    expect(diffReq).toEqual({
      ok: true,
      request: {
        type: 'session.diff',
        requestId: 'req_diff_1',
        sessionId: 'ses_alpha',
      },
    });

    const pushReq = parseBridgeRequest(
      JSON.stringify({
        type: 'push.register',
        requestId: 'req_push_1',
        platform: 'ios',
        provider: 'apns',
        pushToken: 'apns_device_token_123',
      }),
    );
    expect(pushReq).toEqual({
      ok: true,
      request: {
        type: 'push.register',
        requestId: 'req_push_1',
        platform: 'ios',
        provider: 'apns',
        pushToken: 'apns_device_token_123',
      },
    });
  });
});
