import {
  decryptRelayPayload,
  encryptRelayPayload,
  type EncryptedRelayPayload,
} from './crypto.js';

export {
  decryptRelayPayload,
  encryptRelayPayload,
  type EncryptedRelayPayload,
} from './crypto.js';

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_RELAY_URL = 'wss://nienie-replay.quniv.cn' as const;
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

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
  | 'mimo'
  | 'dsh'
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
  /**
   * 事件流实例标识。每次 Adapter/Bridge 启动事件流时生成新的 epoch。
   * 客户端按 (sessionId, streamEpoch, sequence) 判重与排序，
   * 进程重启后 sequence 重置不会被误判为旧事件。
   */
  streamEpoch: string;
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
      /** 客户端生成的消息关联 ID（如 msg_xxx）：随 Prompt 传给 Agent，响应可回传权威 messageId 供乐观消息认领。 */
      clientMessageId?: string | undefined;
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
      streamEpoch?: string | undefined;
      afterSequence: number;
    }
  | {
      type: 'session.snapshot';
      requestId: string;
      sessionId: string;
      streamEpoch?: string | undefined;
    }
  | {
      type: 'screen.capture';
      requestId: string;
      displayId?: string | undefined;
    };

/** 会话快照 V2：Snapshot 是「状态」不是「事件」，与 CanonicalAgentEvent 严格分离。 */
export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SnapshotContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType?: string | undefined; uri?: string | undefined; alt?: string | undefined }
  | { type: 'resource'; uri: string; name?: string | undefined; mimeType?: string | undefined };

export type SnapshotPartBase = {
  /** Session 内稳定唯一（源 Agent 的 ID 或稳定派生）。 */
  partId: string;
  /** 时间线排序位置。 */
  ordinal: number;
  /** 状态版本，同 partId 下严格单调递增（不是文本长度）。 */
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type SnapshotMessagePart = SnapshotPartBase & {
  kind: 'message';
  messageId?: string | undefined;
  role: 'user' | 'assistant';
  content: SnapshotContentBlock[];
};

export type SnapshotThinkingPart = SnapshotPartBase & {
  kind: 'thinking';
  content: string;
};

export type SnapshotToolCallPart = SnapshotPartBase & {
  kind: 'tool_call';
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: string | undefined;
  isError?: boolean | undefined;
  truncated?: boolean | undefined;
  omittedChars?: number | undefined;
  exitCode?: number | undefined;
};

export type SnapshotPermissionPart = SnapshotPartBase & {
  kind: 'permission';
  permissionId: string;
  permission: string;
  detail: string;
  patterns: string[];
  decision?: 'allow_once' | 'allow_always' | 'reject' | undefined;
};

export type SnapshotUsagePart = SnapshotPartBase & {
  kind: 'usage';
  usageId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number | undefined;
  costUsd: number;
};

export type SnapshotErrorPart = SnapshotPartBase & {
  kind: 'error';
  errorId: string;
  code: string;
  message: string;
  retryable: boolean;
};

export type SnapshotFileChangePart = SnapshotPartBase & {
  kind: 'file_change';
  diffId: string;
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};

export type SessionSnapshotPart =
  | SnapshotMessagePart
  | SnapshotThinkingPart
  | SnapshotToolCallPart
  | SnapshotPermissionPart
  | SnapshotUsagePart
  | SnapshotErrorPart
  | SnapshotFileChangePart;

/** Adapter 内部完整状态快照（不允许部分数据）。 */
export type SessionSnapshot = {
  schemaVersion: typeof SESSION_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  sessionId: string;
  agentId: AgentId;
  streamEpoch: string;
  /** Snapshot 完整覆盖的最后一条已应用 CanonicalAgentEvent.sequence。 */
  watermark: number;
  capturedAt: string;
  complete: true;
  hasMore: false;
  totalParts: number;
  parts: SessionSnapshotPart[];
  sessionStatus?: AgentStatus | undefined;
};

/** Bridge 网络传输分页（允许部分数据，客户端只在 complete 时安装）。 */
export type SessionSnapshotPage = {
  schemaVersion: typeof SESSION_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  sessionId: string;
  agentId: AgentId;
  streamEpoch: string;
  watermark: number;
  capturedAt: string;
  parts: SessionSnapshotPart[];
  complete: boolean;
  hasMore: boolean;
  nextCursor?: string | undefined;
  totalParts: number;
};

/** 事件回放结果：按 (sessionId, streamEpoch) 定位，标注截断与是否需快照重置。 */
export type EventsReplayResult = {
  sessionId: string;
  streamEpoch: string;
  earliestSequence: number;
  latestSequence: number;
  /** 服务端缓存已截断，afterSequence 之前的事件可能缺失。 */
  truncated: boolean;
  /** 客户端应丢弃本地时间线、以快照方式重建。 */
  resetRequired: boolean;
  events: CanonicalAgentEvent[];
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
        obj.afterSequence < 0 ||
        (obj.streamEpoch !== undefined && typeof obj.streamEpoch !== 'string')
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
          ...(obj.streamEpoch ? { streamEpoch: obj.streamEpoch } : {}),
          afterSequence: obj.afterSequence,
        },
      };
    }

    case 'session.snapshot': {
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
          type: 'session.snapshot',
          requestId,
          sessionId: obj.sessionId,
          ...(typeof obj.streamEpoch === 'string' ? { streamEpoch: obj.streamEpoch } : {}),
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
  'mimo',
  'dsh',
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
