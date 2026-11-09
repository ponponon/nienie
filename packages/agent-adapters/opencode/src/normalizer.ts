import { randomUUID } from 'node:crypto';
import {
  createCanonicalEvent,
  DEFAULT_MAX_TOOL_OUTPUT_LENGTH,
  redactSensitiveData,
  truncateOutput,
  generateStreamEpoch,
} from '@nienie/agent-events';
import type { AgentStatus, CanonicalAgentEvent, CanonicalAgentEventType } from '@nienie/protocol';

export type OpenCodeNormalizerOptions = {
  agentId?: 'opencode' | 'mimo' | undefined;
  machineId?: string | undefined;
  maxToolOutputLength?: number | undefined;
  now?: (() => Date) | undefined;
  idGenerator?: (() => string) | undefined;
  /** 事件流实例标识；缺省时生成，历史回放与实时事件共享同一 epoch。 */
  streamEpoch?: string | undefined;
};

type RawRecord = Record<string, unknown>;

export class OpenCodeEventNormalizer {
  private readonly agentId: 'opencode' | 'mimo';
  private readonly machineId: string | undefined;
  readonly streamEpoch: string;
  private readonly maxToolOutputLength: number;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  private readonly sequences = new Map<string, number>();
  private readonly userMessageIds = new Set<string>();
  private readonly partTypes = new Map<string, 'text' | 'reasoning'>();
  private readonly partLengths = new Map<string, number>();
  private readonly emittedToolUses = new Set<string>();
  private readonly emittedToolResults = new Set<string>();
  private readonly sessionStatuses = new Map<string, AgentStatus>();

  constructor(options: OpenCodeNormalizerOptions = {}) {
    this.agentId = options.agentId ?? 'opencode';
    this.machineId = options.machineId;
    this.streamEpoch = options.streamEpoch ?? generateStreamEpoch();
    this.maxToolOutputLength = options.maxToolOutputLength ?? DEFAULT_MAX_TOOL_OUTPUT_LENGTH;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => `evt_${randomUUID()}`);
  }

  getSessionStatus(sessionId: string): AgentStatus | undefined {
    return this.sessionStatuses.get(sessionId);
  }

  /** 分配某会话的下一个 sequence（历史回放与实时事件共享同一单调序列，避免撞号）。 */
  /** 只读某会话当前 sequence（不递增），供 Snapshot watermark 使用。 */
  peekSequence(sessionId: string): number {
    return this.sequences.get(sessionId) ?? 0;
  }

  nextSequence(sessionId: string): number {
    const nextSeq = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, nextSeq);
    return nextSeq;
  }

  normalize(rawInput: unknown): CanonicalAgentEvent[] {
    const raw = unwrapGlobalEvent(rawInput);
    if (!raw || typeof raw.type !== 'string') {
      return [];
    }

    const type = raw.type;
    const props = getEventProperties(raw);

    switch (type) {
      case 'server.connected':
      case 'server.heartbeat':
      case 'global.disposed':
        return [];

      case 'session.status':
        return this.handleSessionStatus(props);

      case 'session.idle': {
        const sessionId = asString(props.sessionID);
        if (!sessionId) return [];
        this.sessionStatuses.set(sessionId, 'idle');
        return [
          this.buildEvent(sessionId, 'status', {
            status: 'idle',
            detail: 'Session is idle',
          }),
        ];
      }

      case 'message.updated':
        return this.handleMessageUpdated(props);

      case 'message.part.delta':
        return this.handleMessagePartDelta(props);

      case 'message.part.updated':
        return this.handleMessagePartUpdated(props);

      case 'permission.asked':
      case 'permission.updated':
      case 'permission.v2.asked':
        return this.handlePermissionAsked(props);

      case 'session.error':
        return this.handleSessionError(props);

      case 'session.text.delta':
      case 'session.next.text.delta': {
        const sessionId = asString(props.sessionID);
        const delta = asString(props.delta);
        if (!sessionId || !delta) return [];
        return [this.buildEvent(sessionId, 'text_delta', { delta })];
      }

      case 'session.reasoning.delta':
      case 'session.next.reasoning.delta': {
        const sessionId = asString(props.sessionID);
        const delta = asString(props.delta);
        if (!sessionId || !delta) return [];
        return [this.buildEvent(sessionId, 'thinking_delta', { delta })];
      }

      case 'session.tool.called':
      case 'session.next.tool.called': {
        const sessionId = asString(props.sessionID);
        const callId = asString(props.callID);
        const name = asString(props.name) ?? asString(props.tool) ?? 'tool';
        if (!sessionId || !callId) return [];
        const input = isRecord(props.input) ? redactSensitiveData(props.input) : {};
        return this.emitToolUseIfNeeded(sessionId, callId, name, input);
      }

      case 'session.tool.success':
      case 'session.next.tool.success': {
        const sessionId = asString(props.sessionID);
        const callId = asString(props.callID);
        if (!sessionId || !callId) return [];
        const rawContent = formatToolContent(props.content ?? props.output ?? '');
        return this.emitToolResult(sessionId, callId, rawContent, false);
      }

      case 'session.tool.failed':
      case 'session.next.tool.failed': {
        const sessionId = asString(props.sessionID);
        const callId = asString(props.callID);
        if (!sessionId || !callId) return [];
        const rawError = formatToolContent(props.error ?? props.content ?? 'Tool execution failed');
        return this.emitToolResult(sessionId, callId, rawError, true);
      }

      case 'session.step.ended':
      case 'session.next.step.ended':
        return this.handleStepEnded(props);

      case 'session.step.failed':
      case 'session.next.step.failed':
        return this.handleSessionError(props);

      default:
        return [];
    }
  }

  private handleSessionStatus(props: RawRecord): CanonicalAgentEvent[] {
    const sessionId = asString(props.sessionID);
    const statusObj = isRecord(props.status) ? props.status : undefined;
    if (!sessionId || !statusObj) return [];

    const statusType = asString(statusObj.type);
    if (statusType === 'busy') {
      this.sessionStatuses.set(sessionId, 'running');
      return [
        this.buildEvent(sessionId, 'status', {
          status: 'running',
          detail: 'Session is busy',
        }),
      ];
    }

    if (statusType === 'idle') {
      this.sessionStatuses.set(sessionId, 'idle');
      return [
        this.buildEvent(sessionId, 'status', {
          status: 'idle',
          detail: 'Session is idle',
        }),
      ];
    }

    if (statusType === 'retry') {
      this.sessionStatuses.set(sessionId, 'running');
      return [
        this.buildEvent(sessionId, 'status', {
          status: 'running',
          detail: asString(statusObj.message) ?? 'Retrying step',
          ...(typeof statusObj.attempt === 'number' ? { attempt: statusObj.attempt } : {}),
        }),
      ];
    }

    return [];
  }

  private handleMessageUpdated(props: RawRecord): CanonicalAgentEvent[] {
    const info = isRecord(props.info) ? props.info : undefined;
    if (!info) return [];

    const messageId = asString(info.id);
    const role = asString(info.role);
    if (messageId && role === 'user') {
      this.userMessageIds.add(messageId);
    }
    return [];
  }

  private handleMessagePartDelta(props: RawRecord): CanonicalAgentEvent[] {
    const sessionId = asString(props.sessionID);
    const messageId = asString(props.messageID);
    const partId = asString(props.partID);
    const delta = asString(props.delta);
    const field = asString(props.field);

    if (!sessionId || !delta) return [];
    if (messageId && this.userMessageIds.has(messageId)) return [];

    if (partId) {
      const prevLen = this.partLengths.get(partId) ?? 0;
      this.partLengths.set(partId, prevLen + delta.length);
    }

    const partType = (partId && this.partTypes.get(partId)) ?? (field === 'reasoning' ? 'reasoning' : 'text');
    const eventType: CanonicalAgentEventType = partType === 'reasoning' ? 'thinking_delta' : 'text_delta';

    return [this.buildEvent(sessionId, eventType, { delta })];
  }

  private handleMessagePartUpdated(props: RawRecord): CanonicalAgentEvent[] {
    const part = isRecord(props.part) ? props.part : undefined;
    if (!part) return [];

    const sessionId = asString(part.sessionID) ?? asString(props.sessionID);
    const messageId = asString(part.messageID);
    const partId = asString(part.id);
    const partType = asString(part.type);

    if (!sessionId || !partType) return [];
    if (messageId && this.userMessageIds.has(messageId)) return [];

    if (partType === 'text' || partType === 'reasoning') {
      if (partId) {
        this.partTypes.set(partId, partType);
      }
      const explicitDelta = asString(props.delta);
      const fullText = asString(part.text) ?? '';
      const previousLength = partId ? (this.partLengths.get(partId) ?? 0) : 0;

      let delta = '';
      if (explicitDelta !== undefined) {
        if (fullText.length > previousLength) {
          delta = explicitDelta;
          if (partId) this.partLengths.set(partId, fullText.length);
        } else if (fullText.length === 0 && explicitDelta.length > 0) {
          delta = explicitDelta;
          if (partId) this.partLengths.set(partId, previousLength + explicitDelta.length);
        }
      } else if (fullText.length > previousLength) {
        delta = fullText.slice(previousLength);
        if (partId) this.partLengths.set(partId, fullText.length);
      }

      if (!delta) return [];
      const eventType: CanonicalAgentEventType = partType === 'reasoning' ? 'thinking_delta' : 'text_delta';
      return [this.buildEvent(sessionId, eventType, { delta })];
    }

    if (partType === 'tool') {
      return this.handleToolPart(sessionId, part);
    }

    if (partType === 'step-finish') {
      return this.handleStepEnded({ ...part, sessionID: sessionId });
    }

    return [];
  }

  private handleToolPart(sessionId: string, part: RawRecord): CanonicalAgentEvent[] {
    const callId = asString(part.callID) ?? asString(part.id);
    const toolName = asString(part.tool) ?? 'tool';
    const state = isRecord(part.state) ? part.state : undefined;
    if (!callId || !state) return [];

    const status = asString(state.status);
    const rawInput = isRecord(state.input) ? redactSensitiveData(state.input) : {};

    if (status === 'running') {
      return this.emitToolUseIfNeeded(sessionId, callId, toolName, rawInput);
    }

    if (status === 'completed') {
      const events = this.emitToolUseIfNeeded(sessionId, callId, toolName, rawInput);
      const output = formatToolContent(state.output ?? '');
      events.push(...this.emitToolResult(sessionId, callId, output, false));
      return events;
    }

    if (status === 'error') {
      const events = this.emitToolUseIfNeeded(sessionId, callId, toolName, rawInput);
      const errorText = formatToolContent(state.error ?? 'Tool execution failed');
      events.push(...this.emitToolResult(sessionId, callId, errorText, true));
      return events;
    }

    return [];
  }

  private emitToolUseIfNeeded(
    sessionId: string,
    callId: string,
    name: string,
    input: Record<string, unknown>,
  ): CanonicalAgentEvent[] {
    const key = `${sessionId}:${callId}`;
    if (this.emittedToolUses.has(key)) {
      return [];
    }
    this.emittedToolUses.add(key);
    return [
      this.buildEvent(sessionId, 'tool_use', {
        toolCallId: callId,
        name,
        input,
      }),
    ];
  }

  private emitToolResult(
    sessionId: string,
    callId: string,
    rawContent: string,
    isError: boolean,
  ): CanonicalAgentEvent[] {
    const key = `${sessionId}:${callId}`;
    if (this.emittedToolResults.has(key)) {
      return [];
    }
    this.emittedToolResults.add(key);
    const { content, truncated } = truncateOutput(rawContent, this.maxToolOutputLength);
    return [
      this.buildEvent(sessionId, 'tool_result', {
        toolCallId: callId,
        content,
        isError,
        ...(truncated ? { truncated: true } : {}),
      }),
    ];
  }

  private handlePermissionAsked(props: RawRecord): CanonicalAgentEvent[] {
    const sessionId = asString(props.sessionID);
    if (!sessionId) return [];

    this.sessionStatuses.set(sessionId, 'waiting');
    const permissionId = asString(props.id);
    const permission = asString(props.permission) ?? asString(props.action) ?? asString(props.type) ?? 'permission';
    const title = asString(props.title);
    const patterns = Array.isArray(props.patterns)
      ? props.patterns
      : Array.isArray(props.resources)
        ? props.resources
        : undefined;

    return [
      this.buildEvent(sessionId, 'status', {
        status: 'waiting',
        detail: title ?? `Permission requested: ${permission}`,
        ...(permissionId ? { permissionId } : {}),
        permission,
        ...(patterns ? { patterns } : {}),
      }),
    ];
  }

  private handleStepEnded(props: RawRecord): CanonicalAgentEvent[] {
    const sessionId = asString(props.sessionID);
    const tokens = isRecord(props.tokens) ? props.tokens : undefined;
    if (!sessionId || !tokens) return [];

    const inputTokens = typeof tokens.input === 'number' ? tokens.input : 0;
    const outputTokens = typeof tokens.output === 'number' ? tokens.output : 0;
    const reasoningTokens = typeof tokens.reasoning === 'number' ? tokens.reasoning : undefined;
    const costUsd = typeof props.cost === 'number' ? props.cost : 0;

    return [
      this.buildEvent(sessionId, 'usage', {
        inputTokens,
        outputTokens,
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        costUsd,
      }),
    ];
  }

  private handleSessionError(props: RawRecord): CanonicalAgentEvent[] {
    const sessionId = asString(props.sessionID);
    if (!sessionId) return [];

    const errorObj = isRecord(props.error) ? props.error : undefined;
    const code = asString(errorObj?.name) ?? 'AGENT_EXECUTION_FAILED';
    const dataObj = isRecord(errorObj?.data) ? errorObj.data : undefined;
    const message =
      asString(dataObj?.message) ??
      asString(errorObj?.message) ??
      asString(props.message) ??
      'OpenCode execution failed';
    const retryable = Boolean(dataObj?.isRetryable ?? errorObj?.isRetryable ?? false);

    if (code === 'MessageAbortedError') {
      this.sessionStatuses.set(sessionId, 'cancelled');
    } else {
      this.sessionStatuses.set(sessionId, 'failed');
    }

    return [
      this.buildEvent(sessionId, 'error', {
        code,
        message,
        retryable,
      }),
    ];
  }

  private buildEvent(
    sessionId: string,
    type: CanonicalAgentEventType,
    payload: Record<string, unknown>,
  ): CanonicalAgentEvent {
    const nextSeq = this.nextSequence(sessionId);

    return createCanonicalEvent({
      eventId: this.idGenerator(),
      streamEpoch: this.streamEpoch,
      machineId: this.machineId,
      agentId: this.agentId,
      sessionId,
      sequence: nextSeq,
      timestamp: this.now().toISOString(),
      type,
      payload,
    });
  }
}

function unwrapGlobalEvent(input: unknown): RawRecord | undefined {
  if (!isRecord(input)) return undefined;
  if (isRecord(input.payload) && typeof input.payload.type === 'string') {
    return input.payload;
  }
  return input;
}

function getEventProperties(raw: RawRecord): RawRecord {
  if (isRecord(raw.properties)) return raw.properties;
  if (isRecord(raw.data)) return raw.data;
  return raw;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function formatToolContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
