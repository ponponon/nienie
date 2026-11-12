import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AgentId,
  type AgentInfo,
  type AgentSession,
  type CanonicalAgentEvent,
  type CanonicalAgentEventType,
  type CreateSessionInput,
  type ModelInfo,
  type PermissionDecision,
  type SessionFileDiff,
  type SessionSnapshot,
} from '@nienie/protocol';

export * from './connections.js';
export * from './state-store.js';

export type AgentAdapter = {
  readonly id: AgentId;
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  detect(): Promise<AgentInfo>;
  listModels?(): Promise<ModelInfo[]>;
  listSessions(): Promise<AgentSession[]>;
  createSession?(input?: CreateSessionInput): Promise<AgentSession>;
  loadSession?(sessionId: string): Promise<AgentSession>;
  getSessionDiff?(sessionId: string): Promise<SessionFileDiff[]>;
  /** 获取会话完整快照（Part 状态），供 resetRequired 时原子重建。 */
  getSessionSnapshot?(sessionId: string): Promise<SessionSnapshot>;
  /**
   * 送达语义契约（路线图 3.3 / R3-4）：resolve = 「消息已被 Agent 运行时接受」（delivered=已送达电脑），
   * 不等待整个 Agent 执行完成；执行在后台继续，完成/失败经事件流上报。
   * - spawn 型 Adapter（codex/claude-code/pi）：确认进程真正启动成功（spawn 事件）才 resolve；
   *   spawn 失败必须 reject 并发规范化 error 事件（防假送达），非零退出码同样发 error 事件。
   * - RPC 型（acp）：session/prompt RPC 返回即接受。
   * - stdin 型（pty）：写入成功即接受。
   * 失败（reject）不缓存于 Bridge 幂等层，允许真正重试；成功结果按 clientMessageId 幂等回放。
   */
  sendMessage(
    sessionId: string,
    message: string,
    options?: { modelId?: string | undefined; clientMessageId?: string | undefined },
  ): Promise<{ messageId?: string | undefined } | void>;
  replyPermission?(
    sessionId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void;
  /** 可选：暴露事件流连接诊断（供 Bridge /diagnostics 聚合）。 */
  getDiagnostics?(): unknown;
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
  /** 事件流实例标识（必填）：每个 Adapter 实例固定一个，客户端按 (sessionId, streamEpoch, sequence) 判重。 */
  streamEpoch: string;
  machineId?: string | undefined;
  agentId?: AgentId | undefined;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: CanonicalAgentEventType;
  payload: Record<string, unknown>;
};

/** 生成事件流实例标识（每个 Adapter/事件流实例一个）。 */
export function generateStreamEpoch(): string {
  return `epoch_${randomUUID()}`;
}

export function createCanonicalEvent(input: CreateCanonicalEventInput): CanonicalAgentEvent {
  return {
    version: PROTOCOL_VERSION,
    eventId: input.eventId,
    streamEpoch: input.streamEpoch,
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

export function redactLogText(text: string): string {
  return text
    .replace(/\bntk_[0-9a-zA-Z_-]+\b/g, '[REDACTED]')
    .replace(/\bsk-[0-9a-zA-Z_-]+\b/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[0-9a-zA-Z._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(password|passwd|secret|token|api[-_]?key)\s*([=:])\s*([^\s,;]+)/gi,
      '$1$2[REDACTED]',
    );
}

export type CustomJsonlAdapterOptions = {
  id: AgentId;
  name: string;
  machineId?: string | undefined;
  capabilities?: Partial<AgentCapabilities> | undefined;
  runPrompt: (
    sessionId: string,
    prompt: string,
    emitLine: (line: string) => void,
  ) => Promise<void>;
};

export class CustomJsonlAdapter implements AgentAdapter {
  readonly id: AgentId;
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  private readonly machineId: string | undefined;
  private readonly runPrompt: CustomJsonlAdapterOptions['runPrompt'];
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sequences = new Map<string, number>();
  readonly streamEpoch: string;
  private eventCounter = 0;

  constructor(options: CustomJsonlAdapterOptions) {
    this.id = options.id;
    this.streamEpoch = generateStreamEpoch();
    this.name = options.name;
    this.machineId = options.machineId;
    this.runPrompt = options.runPrompt;
    this.capabilities = {
      streaming: true,
      thinking: true,
      toolCalls: true,
      fileChanges: false,
      permissionRequests: false,
      modelSwitch: false,
      sessionResume: true,
      cancel: true,
      ...options.capabilities,
    };
  }

  async detect(): Promise<AgentInfo> {
    return createAgentInfo(this, true);
  }

  async listSessions(): Promise<AgentSession[]> {
    return [...this.sessions.values()];
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const nowIso = new Date().toISOString();
    const session: AgentSession = {
      id: `ses_${this.id}_${++this.eventCounter}`,
      agentId: this.id,
      title: input.title ?? `${this.name} Session`,
      projectPath: input.projectPath ?? '',
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    return this.createSession({ title: sessionId });
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    await this.runPrompt(sessionId, message, (line) => {
      this.parseAndEmit(sessionId, line);
    });
  }

  async cancel(_sessionId: string): Promise<void> {}

  async dispose(): Promise<void> {
    this.listeners.clear();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private parseAndEmit(sessionId: string, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof raw.type === 'string' ? raw.type : '';
    switch (type) {
      case 'text_delta':
      case 'thinking_delta': {
        const delta = typeof raw.delta === 'string' ? raw.delta : '';
        if (delta) this.emit(sessionId, type, { delta });
        break;
      }
      case 'tool_use': {
        const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : 'call';
        const name = typeof raw.name === 'string' ? raw.name : 'tool';
        const input =
          raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)
            ? redactSensitiveData(raw.input as Record<string, unknown>)
            : {};
        this.emit(sessionId, 'tool_use', { toolCallId, name, input });
        break;
      }
      case 'tool_result': {
        const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : 'call';
        const rawContent = typeof raw.content === 'string' ? raw.content : '';
        const { content, truncated } = truncateOutput(rawContent);
        this.emit(sessionId, 'tool_result', {
          toolCallId,
          content,
          isError: Boolean(raw.isError),
          ...(truncated ? { truncated: true } : {}),
        });
        break;
      }
      case 'status': {
        this.emit(sessionId, 'status', {
          status: typeof raw.status === 'string' ? raw.status : 'idle',
          detail: typeof raw.detail === 'string' ? raw.detail : '',
        });
        break;
      }
      case 'error': {
        this.emit(sessionId, 'error', {
          code: typeof raw.code === 'string' ? raw.code : 'AGENT_ERROR',
          message: typeof raw.message === 'string' ? raw.message : 'Execution failed',
          retryable: Boolean(raw.retryable),
        });
        break;
      }
      default: {
        // Do not silently drop unrecognized error events
        if (typeof raw.error === 'string' && raw.error) {
          this.emit(sessionId, 'error', {
            code: 'UNRECOGNIZED_AGENT_ERROR',
            message: redactLogText(raw.error),
            retryable: false,
          });
        }
        break;
      }
    }
  }

  private emit(
    sessionId: string,
    type: CanonicalAgentEventType,
    payload: Record<string, unknown>,
  ): void {
    const seq = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, seq);
    const evt = createCanonicalEvent({
      eventId: `cevt_${++this.eventCounter}`,
      streamEpoch: this.streamEpoch,
      machineId: this.machineId,
      agentId: this.id,
      sessionId,
      sequence: seq,
      timestamp: new Date().toISOString(),
      type,
      payload,
    });
    for (const listener of this.listeners) listener(evt);
  }
}
