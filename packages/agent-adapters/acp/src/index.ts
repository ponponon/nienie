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

        // F4：ACP v2 turn 生命周期——state_update 上报运行/失败/结束
        case 'state_update': {
          const state = asString(update.state);
          if (state === 'running') {
            return [
              this.buildEvent(sessionId, 'status', {
                status: 'running',
                detail: `ACP ${state}`,
              }),
            ];
          }
          // F4-D：requires_action=前台任务等待用户操作（权限/输入），不是普通 running——
          // 映射 waiting，UI 不得继续显示 Thinking
          if (state === 'requires_action') {
            return [
              this.buildEvent(sessionId, 'status', {
                status: 'waiting',
                detail: 'ACP requires_action（等待用户操作）',
              }),
            ];
          }
          if (state === 'idle') {
            const stopReason = asString(update.stopReason);
            const events: CanonicalAgentEvent[] = [];
            if (stopReason === 'error') {
              const err = isRecord(update.error) ? update.error : {};
              events.push(
                this.buildEvent(sessionId, 'error', {
                  code: 'RUN_FAILED',
                  message: asString(err.message) ?? 'ACP turn failed',
                  retryable: true,
                }),
              );
            }
            events.push(
              this.buildEvent(sessionId, 'status', {
                status: stopReason === 'error' ? 'failed' : 'idle',
                detail: `ACP turn ended (${stopReason ?? 'unknown'})`,
              }),
            );
            return events;
          }
          return [];
        }
      }
    }

    return [];
  }

  /** 公开供 Adapter 直接构造事件（同一会话序号空间，防重复 sequence）。 */
  buildEvent(
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
  /** F4：ACP 协议版本——2=session/prompt 插入即返回 messageId（接受语义）；1=响应即 turn 完成。 */
  private protocolVersion: 1 | 2 = 1;
  private agentVersion: string | undefined;
  private initPromise: Promise<void> | undefined;

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

  /**
   * F4：初始化协商协议版本（幂等，只发一次 initialize——重复 initialize 会被 Agent 以 -32600 拒绝）。
   * 优先 protocolVersion 2（v2：prompt 插入即返回 messageId=接受确认）；
   * Agent 回显 1 / 不支持 2 时回落 v1（v1：prompt 响应=整个 turn 完成，不谎称接受）。
   */
  private ensureInitialized(): Promise<void> {
    this.initPromise ??= (async () => {
      if (!this.transport) return;
      try {
        // F4-A：v2 initialize 必须携带 info + capabilities（否则真 v2 Agent 可拒参数）
        const res = (await this.transport.request('initialize', {
          protocolVersion: 2,
          info: { name: 'nienie-bridge', title: 'Nienie Bridge', version: '0.1.0' },
          capabilities: {},
        })) as
          | {
              protocolVersion?: number;
              info?: { version?: string };
              agentInfo?: { version?: string };
            }
          | undefined;
        // F4-A：v2 响应用 info；agentInfo 是 v1 字段（兼容读取）
        this.agentVersion = res?.info?.version ?? res?.agentInfo?.version;
        this.protocolVersion = res?.protocolVersion === 2 ? 2 : 1;
      } catch (error) {
        // F4：仅在 Agent 明确拒绝请求（JSON-RPC 错误带 code）时回落 v1——
        // 传输层错误不重试 initialize（legacy Agent 不一定支持重复初始化，
        // 需要 Bridge 重建连接后重新协商）
        const isProtocolRejection =
          typeof error === 'object' && error !== null && 'code' in error;
        if (!isProtocolRejection) {
          throw error;
        }
        const res = (await this.transport.request('initialize', {
          protocolVersion: 1,
          info: { name: 'nienie-bridge', title: 'Nienie Bridge', version: '0.1.0' },
          capabilities: {},
        })) as { protocolVersion?: number; agentInfo?: { version?: string } } | undefined;
        this.agentVersion = res?.agentInfo?.version;
        this.protocolVersion = 1;
      }
    })();
    return this.initPromise;
  }

  async detect() {
    if (!this.transport) {
      return createAgentInfo(this, false);
    }
    try {
      await this.ensureInitialized();
      return createAgentInfo(this, true, this.agentVersion);
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
    await this.ensureInitialized();
    if (this.protocolVersion === 2) {
      // F4-B：v2 已移除 session/load，恢复用 session/resume（replayFrom start 重放完整历史）
      await this.transport.request('session/resume', {
        sessionId,
        cwd: this.defaultProjectPath,
        replayFrom: { type: 'start' },
      });
    } else {
      await this.transport.request('session/load', {
        sessionId,
        cwd: this.defaultProjectPath,
      });
    }
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

  async sendMessage(
    sessionId: string,
    message: string,
  ): Promise<{ messageId?: string | undefined } | void> {
    if (!this.transport) {
      throw new Error('ACP transport is not configured');
    }
    await this.ensureInitialized();
    const params = {
      sessionId,
      prompt: [{ type: 'text', text: message }],
    };

    if (this.protocolVersion === 2) {
      // F4 v2：prompt 插入（用户消息入列）即返回 messageId——接受语义与统一契约一致
      const res = (await this.transport.request('session/prompt', params)) as
        | { messageId?: string }
        | undefined;
      const messageId = asString(res?.messageId);
      // F4-C：v2 成功响应必须携带非空 messageId——缺失=协议违规，抛错拒绝「假送达」
      if (!messageId) {
        throw new Error('ACP v2 prompt response missing messageId（拒绝假送达）');
      }
      return { messageId };
    }

    // F4 v1：session/prompt 的响应=整个 turn 完成，不是接受确认。
    // 送达语义=请求已派发至 Agent 进程（与 pty stdin 写入同语义），不谎称 Agent 已接受；
    // turn 完成/失败经事件流上报（status/error）。
    let dispatched: Promise<unknown>;
    try {
      dispatched = Promise.resolve(this.transport.request('session/prompt', params));
    } catch (error) {
      throw error; // 同步失败（未连接等）→ 拒绝接受
    }
    void dispatched.then(
      () => {
        this.emitDirect(sessionId, 'status', {
          status: 'idle',
          detail: 'ACP turn completed',
        });
      },
      (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.emitDirect(sessionId, 'error', {
          code: 'RUN_FAILED',
          message: `ACP turn 失败: ${detail}`,
          retryable: true,
        });
        this.emitDirect(sessionId, 'status', { status: 'failed', detail });
      },
    );
    return;
  }

  /** v1 派发路径的回合结束/失败上报（与常规事件同一会话序号空间）。 */
  private emitDirect(
    sessionId: string,
    type: CanonicalAgentEventType,
    payload: Record<string, unknown>,
  ): void {
    const event = this.normalizer.buildEvent(sessionId, type, payload);
    for (const listener of this.listeners) listener(event);
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
