import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AgentId,
  type AgentInfo,
  type AgentSession,
  type CanonicalAgentEvent,
  type CanonicalAgentEventType,
  type CreateSessionInput,
} from '@nienie/protocol';

export type AgentAdapter = {
  readonly id: AgentId;
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  detect(): Promise<AgentInfo>;
  listSessions(): Promise<AgentSession[]>;
  createSession?(input?: CreateSessionInput): Promise<AgentSession>;
  loadSession?(sessionId: string): Promise<AgentSession>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void;
};

export function createAgentInfo(
  adapter: Pick<AgentAdapter, 'id' | 'name' | 'capabilities'>,
  available: boolean,
  version?: string,
): AgentInfo {
  return {
    id: adapter.id,
    name: adapter.name,
    available,
    ...(version ? { version } : {}),
    capabilities: adapter.capabilities,
  };
}

export type CreateCanonicalEventInput = {
  eventId: string;
  machineId?: string;
  agentId?: AgentId;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: CanonicalAgentEventType;
  payload: Record<string, unknown>;
};

export function createCanonicalEvent(input: CreateCanonicalEventInput): CanonicalAgentEvent {
  return {
    version: PROTOCOL_VERSION,
    eventId: input.eventId,
    ...(input.machineId ? { machineId: input.machineId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    sessionId: input.sessionId,
    sequence: input.sequence,
    timestamp: input.timestamp,
    type: input.type,
    payload: input.payload,
  };
}

const SENSITIVE_KEY_PATTERN = /(api[-_]?key|password|secret|token|authorization|credential|cookie)/i;

export function redactSensitiveData<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof entry === 'string') {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSensitiveData(entry);
      }
    }
    return result as T;
  }
  return value;
}

export const DEFAULT_MAX_TOOL_OUTPUT_LENGTH = 16_384;

export function truncateOutput(
  content: string,
  maxLength: number = DEFAULT_MAX_TOOL_OUTPUT_LENGTH,
): { content: string; truncated: boolean } {
  if (content.length <= maxLength) {
    return { content, truncated: false };
  }
  const omitted = content.length - maxLength;
  return {
    content: `${content.slice(0, maxLength)}\n...[truncated ${omitted} chars]`,
    truncated: true,
  };
}
