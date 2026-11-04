import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_RELAY_URL = 'wss://nienie-replay.quniv.cn' as const;
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export type EncryptedRelayPayload = {
  alg: 'aes-256-gcm';
  iv: string;
  ciphertext: string;
  tag: string;
};

export function encryptRelayPayload(
  plaintext: string,
  sharedSecret: string,
): EncryptedRelayPayload {
  const key = deriveRelayKey(sharedSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    ciphertext: encrypted.toString('base64url'),
    tag: tag.toString('base64url'),
  };
}

export function decryptRelayPayload(
  box: EncryptedRelayPayload,
  sharedSecret: string,
): string {
  if (box.alg !== 'aes-256-gcm') {
    throw new Error(`Unsupported encryption algorithm: ${String(box.alg)}`);
  }
  const key = deriveRelayKey(sharedSecret);
  const iv = Buffer.from(box.iv, 'base64url');
  const ciphertext = Buffer.from(box.ciphertext, 'base64url');
  const tag = Buffer.from(box.tag, 'base64url');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

function deriveRelayKey(sharedSecret: string): Buffer {
  return createHash('sha256').update(`nienie-relay-v1:${sharedSecret}`).digest();
}

export type RelayWireMessage =
  | {
      type: 'relay.register';
      role: 'bridge' | 'mobile';
      machineId: string;
      clientId: string;
    }
  | {
      type: 'relay.registered';
      role: 'bridge' | 'mobile';
      machineId: string;
      clientId: string;
      bridgeOnline: boolean;
    }
  | {
      type: 'relay.presence';
      machineId: string;
      bridgeOnline: boolean;
    }
  | {
      type: 'relay.forward';
      machineId: string;
      fromClientId: string;
      toClientId?: string | undefined;
      payload?: string | undefined;
      encrypted?: EncryptedRelayPayload | undefined;
    }
  | {
      type: 'relay.error';
      code: string;
      machineId: string;
      message: string;
    };

export function resolveRelayUrl(customUrl?: string): string {
  const value = customUrl?.trim();
  return value || DEFAULT_RELAY_URL;
}

export type AgentId =
  | 'opencode'
  | 'codex'
  | 'claude-code'
  | 'pi'
  | 'acp'
  | 'openclaw'
  | 'pty';
export type AgentStatus = 'starting' | 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type AgentCapabilities = {
  streaming: boolean;
  thinking: boolean;
  toolCalls: boolean;
  fileChanges: boolean;
  permissionRequests: boolean;
  modelSwitch: boolean;
  sessionResume: boolean;
  cancel: boolean;
};

export type AgentInfo = {
  id: AgentId;
  name: string;
  available: boolean;
  version?: string | undefined;
  capabilities: AgentCapabilities;
};

export type ModelInfo = {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  isDefault: boolean;
};

export type SessionFileDiff = {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};

export type ScreenCaptureFrame = {
  frameId: string;
  displayId: string;
  mimeType: string;
  width: number;
  height: number;
  base64Data: string;
  capturedAt: string;
};

export type AgentSession = {
  id: string;
  agentId: AgentId;
  title: string;
  projectPath: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateSessionInput = {
  title?: string | undefined;
  projectPath?: string | undefined;
  parentSessionId?: string | undefined;
};

export type DevicePlatform = 'ios' | 'android' | 'unknown';

export type PairingQrPayload = {
  version: typeof PROTOCOL_VERSION;
  machineId: string;
  wsUrl: string;
  relayUrl?: string | undefined;
  pairingCode: string;
  expiresAt: string;
};

export type PairedDevice = {
  deviceId: string;
  deviceName: string;
  platform: DevicePlatform;
  pairedAt: string;
  lastSeenAt: string;
  revokedAt?: string | undefined;
};

export function encodePairingQrPayload(payload: PairingQrPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `nienie://pair?data=${encoded}`;
}

export function decodePairingQrPayload(input: string): PairingQrPayload {
  const trimmed = input.trim();
  let jsonText = trimmed;
  if (trimmed.startsWith('nienie://')) {
    const url = new URL(trimmed);
    const dataParam = url.searchParams.get('data');
    if (!dataParam) {
      throw new Error('Missing data parameter in pairing QR URI');
    }
    jsonText = Buffer.from(dataParam, 'base64url').toString('utf8');
  }
  const parsed = JSON.parse(jsonText) as Partial<PairingQrPayload>;
  if (
    parsed.version !== PROTOCOL_VERSION ||
    typeof parsed.machineId !== 'string' ||
    typeof parsed.wsUrl !== 'string' ||
    typeof parsed.pairingCode !== 'string' ||
    typeof parsed.expiresAt !== 'string'
  ) {
    throw new Error('Invalid pairing QR payload');
  }
  return {
    version: PROTOCOL_VERSION,
    machineId: parsed.machineId,
    wsUrl: parsed.wsUrl,
    ...(typeof parsed.relayUrl === 'string' ? { relayUrl: parsed.relayUrl } : {}),
    pairingCode: parsed.pairingCode,
    expiresAt: parsed.expiresAt,
  };
}

export type CanonicalAgentEventType =
  | 'status'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'usage'
  | 'error';

export type CanonicalAgentEvent = {
  version: typeof PROTOCOL_VERSION;
  eventId: string;
  machineId?: string | undefined;
  agentId?: AgentId | undefined;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: CanonicalAgentEventType;
  payload: Record<string, unknown>;
};

export type PermissionDecision = 'allow_once' | 'allow_always' | 'reject';
export type PushProvider = 'apns' | 'fcm' | 'webhook';

export type BridgeRequest =
  | { type: 'hello'; requestId: string; protocolVersion: typeof PROTOCOL_VERSION; deviceToken?: string | undefined }
  | { type: 'ping'; requestId: string }
  | {
      type: 'pair.confirm';
      requestId: string;
      pairingCode: string;
      deviceName: string;
      platform?: DevicePlatform | undefined;
    }
  | {
      type: 'push.register';
      requestId: string;
      platform: DevicePlatform;
      provider: PushProvider;
      pushToken: string;
    }
  | { type: 'machine.get'; requestId: string }
  | { type: 'agents.list'; requestId: string }
  | { type: 'models.list'; requestId: string; agentId: AgentId }
  | { type: 'sessions.list'; requestId: string }
  | { type: 'session.create'; requestId: string; agentId: AgentId; input?: CreateSessionInput | undefined }
  | { type: 'session.load'; requestId: string; agentId: AgentId; sessionId: string }
  | { type: 'session.state'; requestId: string; sessionId: string; agentId?: AgentId | undefined }
  | { type: 'session.diff'; requestId: string; sessionId: string; agentId?: AgentId | undefined }
  | {
      type: 'session.send';
      requestId: string;
      sessionId: string;
      message: string;
      agentId?: AgentId | undefined;
      modelId?: string | undefined;
    }
  | { type: 'session.cancel'; requestId: string; sessionId: string }
  | {
      type: 'permission.reply';
      requestId: string;
      sessionId: string;
      permissionId: string;
      decision: PermissionDecision;
      agentId?: AgentId | undefined;
    }
  | {
      type: 'events.replay';
      requestId: string;
      sessionId: string;
      afterSequence: number;
    }
  | {
      type: 'screen.capture';
      requestId: string;
      displayId?: string | undefined;
    };

export type BridgeResponse =
  | { type: 'response'; requestId: string; ok: true; data: unknown }
  | { type: 'response'; requestId: string; ok: false; error: { code: string; message: string } }
  | { type: 'session.event'; event: CanonicalAgentEvent };

export type ParseBridgeRequestResult =
  | { ok: true; request: BridgeRequest }
  | { ok: false; requestId: string; error: { code: string; message: string } };

export function parseBridgeRequest(
  rawText: string,
  maxBytes: number = DEFAULT_MAX_MESSAGE_BYTES,
): ParseBridgeRequestResult {
  const byteLength = Buffer.byteLength(rawText, 'utf8');
  if (byteLength > maxBytes) {
    return {
      ok: false,
      requestId: 'unknown',
      error: {
        code: 'MESSAGE_TOO_LARGE',
        message: `Message size ${byteLength} exceeds maximum ${maxBytes} bytes`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      requestId: 'unknown',
      error: {
        code: 'INVALID_JSON',
        message: 'Message must be valid JSON',
      },
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      requestId: 'unknown',
      error: {
        code: 'BAD_REQUEST',
        message: 'Message must be a JSON object',
      },
    };
  }

  const obj = parsed as Record<string, unknown>;
  const requestId = typeof obj.requestId === 'string' && obj.requestId.trim() ? obj.requestId : 'unknown';
  if (requestId === 'unknown') {
    return {
      ok: false,
      requestId,
      error: {
        code: 'BAD_REQUEST',
        message: 'Missing or invalid requestId',
      },
    };
  }

  const type = obj.type;
  if (typeof type !== 'string') {
    return {
      ok: false,
      requestId,
      error: {
        code: 'BAD_REQUEST',
        message: 'Missing request type',
      },
    };
  }

  switch (type) {
    case 'hello': {
      if (obj.protocolVersion !== PROTOCOL_VERSION) {
        return {
          ok: false,
          requestId,
          error: {
            code: 'UNSUPPORTED_PROTOCOL_VERSION',
            message: `Unsupported protocol version: ${String(obj.protocolVersion)}`,
          },
        };
      }
      return {
        ok: true,
        request: {
          type: 'hello',
          requestId,
          protocolVersion: PROTOCOL_VERSION,
          ...(typeof obj.deviceToken === 'string' ? { deviceToken: obj.deviceToken } : {}),
        },
      };
    }

    case 'ping':
      return { ok: true, request: { type: 'ping', requestId } };

    case 'pair.confirm': {
      if (
        typeof obj.pairingCode !== 'string' ||
        !obj.pairingCode.trim() ||
        typeof obj.deviceName !== 'string' ||
        !obj.deviceName.trim()
      ) {
        return {
          ok: false,
          requestId,
          error: { code: 'BAD_REQUEST', message: 'Invalid pairingCode or deviceName' },
        };
      }
      const platform = isDevicePlatform(obj.platform) ? obj.platform : undefined;
      return {
        ok: true,
        request: {
          type: 'pair.confirm',
          requestId,
          pairingCode: obj.pairingCode.trim(),
          deviceName: obj.deviceName.trim(),
          ...(platform ? { platform } : {}),
        },
      };
    }

    case 'push.register': {
      if (
        !isDevicePlatform(obj.platform) ||
        !isPushProvider(obj.provider) ||
        typeof obj.pushToken !== 'string' ||
        !obj.pushToken.trim()
      ) {
        return {
          ok: false,
          requestId,
          error: {
            code: 'BAD_REQUEST',
            message: 'Invalid platform, provider, or pushToken',
          },
        };
      }
      return {
        ok: true,
        request: {
          type: 'push.register',
          requestId,
          platform: obj.platform,
          provider: obj.provider,
          pushToken: obj.pushToken.trim(),
        },
      };
    }

    case 'agents.list':
      return { ok: true, request: { type: 'agents.list', requestId } };

    case 'models.list': {
      if (!isAgentId(obj.agentId)) {
        return {
          ok: false,
          requestId,
          error: { code: 'BAD_REQUEST', message: 'Invalid or missing agentId' },
        };
      }
      return {
        ok: true,
        request: { type: 'models.list', requestId, agentId: obj.agentId },
      };
    }

    case 'machine.get':
      return { ok: true, request: { type: 'machine.get', requestId } };

    case 'sessions.list':
      return { ok: true, request: { type: 'sessions.list', requestId } };

    case 'session.create': {
      if (!isAgentId(obj.agentId)) {
        return {
          ok: false,
          requestId,
          error: { code: 'BAD_REQUEST', message: 'Invalid or missing agentId' },
        };
      }
      const input =
        obj.input && typeof obj.input === 'object' && !Array.isArray(obj.input)
          ? (obj.input as CreateSessionInput)
          : undefined;
      return {
        ok: true,
        request: {
          type: 'session.create',
          requestId,
          agentId: obj.agentId,
          ...(input ? { input } : {}),
        },
      };
    }

    case 'session.load': {
      if (!isAgentId(obj.agentId) || typeof obj.sessionId !== 'string' || !obj.sessionId.trim()) {
        return {
          ok: false,
          requestId,
          error: { code: 'BAD_REQUEST', message: 'Invalid agentId or sessionId' },
        };
      }
      return {
        ok: true,
        request: {
          type: 'session.load',
          requestId,
          agentId: obj.agentId,
          sessionId: obj.sessionId,
        },
      };
    }

    case 'session.send': {
      if (
        typeof obj.sessionId !== 'string' ||
        !obj.sessionId.trim() ||
        typeof obj.message !== 'string'
      ) {
        return {
          ok: false,
          requestId,
          error: { code: 'BAD_REQUEST', message: 'Invalid sessionId or message' },
        };
      }
      return {
        ok: true,
        request: {
          type: 'session.send',
          requestId,
          sessionId: obj.sessionId,
          message: obj.message,
          ...(isAgentId(obj.agentId) ? { agentId: obj.agentId } : {}),
          ...(typeof obj.modelId === 'string' && obj.modelId.trim()
            ? { modelId: obj.modelId.trim() }
            : {}),
        },
      };
    }

    case 'session.cancel': {
      if (typeof obj.sessionId !== 'string' || !obj.sessionId.trim()) {
        return {
          ok: false,
          requestId,
          error: { code: 'BAD_REQUEST', message: 'Invalid sessionId' },
        };
      }
      return {
        ok: true,
        request: {
          type: 'session.cancel',
          requestId,
          sessionId: obj.sessionId,
        },
      };
    }

    case 'session.state': {
      if (typeof obj.sessionId !== 'string' || !obj.sessionId.trim()) {
        return {
          ok: false,
          requestId,
          error: { code: 'BAD_REQUEST', message: 'Invalid sessionId' },
        };
      }
      return {
        ok: true,
        request: {
          type: 'session.state',
          requestId,
          sessionId: obj.sessionId,
          ...(isAgentId(obj.agentId) ? { agentId: obj.agentId } : {}),
        },
      };
    }

    case 'session.diff': {
      if (typeof obj.sessionId !== 'string' || !obj.sessionId.trim()) {
        return {
          ok: false,
          requestId,
          error: { code: 'BAD_REQUEST', message: 'Invalid sessionId' },
        };
      }
      return {
        ok: true,
        request: {
          type: 'session.diff',
          requestId,
          sessionId: obj.sessionId,
          ...(isAgentId(obj.agentId) ? { agentId: obj.agentId } : {}),
        },
      };
    }

    case 'permission.reply': {
      if (
        typeof obj.sessionId !== 'string' ||
        !obj.sessionId.trim() ||
        typeof obj.permissionId !== 'string' ||
        !obj.permissionId.trim() ||
        !isPermissionDecision(obj.decision)
      ) {
        return {
          ok: false,
          requestId,
          error: {
            code: 'BAD_REQUEST',
            message: 'Invalid sessionId, permissionId, or decision',
          },
        };
      }
      return {
        ok: true,
        request: {
          type: 'permission.reply',
          requestId,
          sessionId: obj.sessionId,
          permissionId: obj.permissionId,
          decision: obj.decision,
          ...(isAgentId(obj.agentId) ? { agentId: obj.agentId } : {}),
        },
      };
    }

    case 'events.replay': {
      if (
        typeof obj.sessionId !== 'string' ||
        !obj.sessionId.trim() ||
        typeof obj.afterSequence !== 'number' ||
        !Number.isInteger(obj.afterSequence) ||
        obj.afterSequence < 0
      ) {
        return {
          ok: false,
          requestId,
          error: { code: 'BAD_REQUEST', message: 'Invalid sessionId or afterSequence' },
        };
      }
      return {
        ok: true,
        request: {
          type: 'events.replay',
          requestId,
          sessionId: obj.sessionId,
          afterSequence: obj.afterSequence,
        },
      };
    }

    case 'screen.capture': {
      const displayId =
        typeof obj.displayId === 'string' && obj.displayId.trim()
          ? obj.displayId.trim()
          : undefined;
      return {
        ok: true,
        request: {
          type: 'screen.capture',
          requestId,
          ...(displayId ? { displayId } : {}),
        },
      };
    }

    default:
      return {
        ok: false,
        requestId,
        error: {
          code: 'UNKNOWN_COMMAND',
          message: `Unknown command type: ${type}`,
        },
      };
  }
}

const VALID_AGENT_IDS = new Set<AgentId>([
  'opencode',
  'codex',
  'claude-code',
  'pi',
  'acp',
  'openclaw',
  'pty',
]);

function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && VALID_AGENT_IDS.has(value as AgentId);
}

function isDevicePlatform(value: unknown): value is DevicePlatform {
  return value === 'ios' || value === 'android' || value === 'unknown';
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return value === 'allow_once' || value === 'allow_always' || value === 'reject';
}

function isPushProvider(value: unknown): value is PushProvider {
  return value === 'apns' || value === 'fcm' || value === 'webhook';
}
