export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_RELAY_URL = 'wss://nienie-replay.quniv.cn' as const;
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export function resolveRelayUrl(customUrl?: string): string {
  const value = customUrl?.trim();
  return value || DEFAULT_RELAY_URL;
}

export type AgentId = 'opencode' | 'codex';
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
  | { type: 'agents.list'; requestId: string }
  | { type: 'sessions.list'; requestId: string }
  | { type: 'session.create'; requestId: string; agentId: AgentId; input?: CreateSessionInput | undefined }
  | { type: 'session.load'; requestId: string; agentId: AgentId; sessionId: string }
  | { type: 'session.send'; requestId: string; sessionId: string; message: string; agentId?: AgentId | undefined }
  | { type: 'session.cancel'; requestId: string; sessionId: string };

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

    case 'agents.list':
      return { ok: true, request: { type: 'agents.list', requestId } };

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

function isAgentId(value: unknown): value is AgentId {
  return value === 'opencode' || value === 'codex';
}

function isDevicePlatform(value: unknown): value is DevicePlatform {
  return value === 'ios' || value === 'android' || value === 'unknown';
}
