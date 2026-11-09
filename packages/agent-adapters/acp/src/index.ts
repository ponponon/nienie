import { randomUUID } from 'node:crypto';
import {
  createAgentInfo,
  createCanonicalEvent,
  generateStreamEpoch,
  DEFAULT_MAX_TOOL_OUTPUT_LENGTH,
  redactSensitiveData,
  truncateOutput,
  type AgentAdapter,
} from '@nienie/agent-events';
import type {
  AgentSession,
  CanonicalAgentEvent,
  CanonicalAgentEventType,
  CreateSessionInput,
} from '@nienie/protocol';

const capabilities = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  fileChanges: true,
  permissionRequests: true,
  modelSwitch: false,
  sessionResume: true,
  cancel: true,
} as const;

export type AcpNormalizerOptions = {
  machineId?: string | undefined;
  maxToolOutputLength?: number | undefined;
  now?: (() => Date) | undefined;
  idGenerator?: (() => string) | undefined;
  streamEpoch?: string | undefined;
};

type RawRecord = Record<string, unknown>;

export class AcpEventNormalizer {
  private readonly machineId: string | undefined;
  private readonly maxToolOutputLength: number;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly sequences = new Map<string, number>();
  readonly streamEpoch: string;

  constructor(options: AcpNormalizerOptions = {}) {
    this.machineId = options.machineId;
    this.streamEpoch = options.streamEpoch ?? generateStreamEpoch();
    this.maxToolOutputLength = options.maxToolOutputLength ?? DEFAULT_MAX_TOOL_OUTPUT_LENGTH;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => `evt_${randomUUID()}`);
  }

  normalize(rawMessage: unknown): CanonicalAgentEvent[] {
    if (!isRecord(rawMessage)) return [];

    // JSON-RPC 2.0 notification: { jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }
    const method = asString(rawMessage.method);
    const params = isRecord(rawMessage.params) ? rawMessage.params : rawMessage;
    const sessionId = asString(params.sessionId);
    if (!sessionId) return [];

    if (method === 'session/update' || isRecord(params.update)) {
      const update = isRecord(params.update) ? params.update : params;
      const sessionUpdate = asString(update.sessionUpdate) ?? asString(update.type);

      switch (sessionUpdate) {
        case 'agent_thought_chunk': {
          const content = isRecord(update.content) ? update.content : update;
          const delta = asString(content.text) ?? asString(update.delta) ?? '';
          if (!delta) return [];
          return [this.buildEvent(sessionId, 'thinking_delta', { delta })];
        }

        case 'agent_message_chunk': {
          const content = isRecord(update.content) ? update.content : update;
          const delta = asString(content.text) ?? asString(update.delta) ?? '';
          if (!delta) return [];
          return [this.buildEvent(sessionId, 'text_delta', { delta })];
        }

        case 'tool_call': {
          const toolCallId = asString(update.toolCallId) ?? `acp_call_${randomUUID()}`;
          const name = asString(update.title) ?? asString(update.name) ?? 'tool';
          const input = isRecord(update.rawInput)
            ? redactSensitiveData(update.rawInput)
            : isRecord(update.input)
              ? redactSensitiveData(update.input)
              : {};
          return [
            this.buildEvent(sessionId, 'tool_use', {
              toolCallId,
              name,
              input,
            }),
          ];
        }

        case 'tool_call_update': {
          const toolCallId = asString(update.toolCallId) ?? '';
          const status = asString(update.status);
          if (!toolCallId || (status !== 'completed' && status !== 'failed')) return [];
          const rawContent = asString(update.rawOutput) ?? asString(update.content) ?? '';
          const { content, truncated } = truncateOutput(rawContent, this.maxToolOutputLength);
          return [
            this.buildEvent(sessionId, 'tool_result', {
              toolCallId,
              content,
              isError: status === 'failed',
              ...(truncated ? { truncated: true } : {}),
            }),
          ];
        }

        case 'status': {
          const status = asString(update.status) ?? 'idle';
          return [
            this.buildEvent(sessionId, 'status', {
              status,
              detail: asString(update.detail) ?? `ACP session ${status}`,
            }),
          ];
        }
      }
    }

    return [];
  }

  private buildEvent(
    sessionId: string,
    type: CanonicalAgentEventType,
    payload: Record<string, unknown>,
  ): CanonicalAgentEvent {
    const nextSeq = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, nextSeq);

    return createCanonicalEvent({
      streamEpoch: this.streamEpoch,
      eventId: this.idGenerator(),
      machineId: this.machineId,
      agentId: 'acp',
      sessionId,
      sequence: nextSeq,
      timestamp: this.now().toISOString(),
      type,
      payload,
    });
  }
}

export type AcpTransport = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(listener: (notification: unknown) => void): () => void;
  close(): Promise<void>;
};

export type AcpAdapterOptions = AcpNormalizerOptions & {
  transport?: AcpTransport | undefined;
  defaultProjectPath?: string | undefined;
};

export class AcpAdapter implements AgentAdapter {
  readonly id = 'acp' as const;
  readonly name = 'ACP Agent';
  readonly capabilities = { ...capabilities };

  private readonly transport: AcpTransport | undefined;
  private readonly defaultProjectPath: string;
  private readonly normalizer: AcpEventNormalizer;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sessions = new Map<string, AgentSession>();
  private unsubscribeTransport: (() => void) | undefined;

  constructor(options: AcpAdapterOptions = {}) {
    this.transport = options.transport;
    this.defaultProjectPath = options.defaultProjectPath ?? process.cwd();
    this.normalizer = new AcpEventNormalizer(options);

    if (this.transport) {
      this.unsubscribeTransport = this.transport.onNotification((msg) => {
        for (const evt of this.normalizer.normalize(msg)) {
          for (const listener of this.listeners) listener(evt);
        }
      });
    }
  }

  async detect() {
    if (!this.transport) {
      return createAgentInfo(this, false);
    }
    try {
      const res = (await this.transport.request('initialize', {
        protocolVersion: 1,
      })) as { agentInfo?: { version?: string } } | undefined;
      return createAgentInfo(this, true, res?.agentInfo?.version);
    } catch {
      return createAgentInfo(this, false);
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    return [...this.sessions.values()];
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    if (!this.transport) {
      throw new Error('ACP transport is not configured');
    }
    const cwd = input.projectPath ?? this.defaultProjectPath;
    const res = (await this.transport.request('session/new', { cwd })) as {
      sessionId?: string;
    };
    const nowIso = new Date().toISOString();
    const session: AgentSession = {
      id: res?.sessionId ?? `acp_ses_${randomUUID()}`,
      agentId: 'acp',
      title: input.title ?? 'ACP Session',
      projectPath: cwd,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    if (!this.transport) {
      throw new Error('ACP transport is not configured');
    }
    await this.transport.request('session/load', {
      sessionId,
      cwd: this.defaultProjectPath,
    });
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const nowIso = new Date().toISOString();
    const session: AgentSession = {
      id: sessionId,
      agentId: 'acp',
      title: `ACP Session ${sessionId.slice(0, 8)}`,
      projectPath: this.defaultProjectPath,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    if (!this.transport) {
      throw new Error('ACP transport is not configured');
    }
    await this.transport.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: message }],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.transport) {
      throw new Error('ACP transport is not configured');
    }
    await this.transport.request('session/cancel', { sessionId });
  }

  async dispose(): Promise<void> {
    if (this.unsubscribeTransport) {
      this.unsubscribeTransport();
      this.unsubscribeTransport = undefined;
    }
    if (this.transport) {
      await this.transport.close();
    }
    this.listeners.clear();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
