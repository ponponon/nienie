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
  /**
   * F4-2：按 Session 隔离的 upsert 状态（ACP 的 messageId/toolCallId 只在会话内唯一）：
   * `${sessionId}#${messageId}` → 已累计文本 + revision（完整消息 upsert 覆盖 / chunk 追加）
   */
  private readonly messageState = new Map<string, { content: string; revision: number }>();
  /** `${sessionId}#${toolCallId}` → 工具内容状态（tool_call_update.content 整体替换 / content_chunk 追加）。 */
  private readonly toolState = new Map<
    string,
    { content: string; useEmitted: boolean }
  >();
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
        // F4-2：v2 消息更新——content 为 ContentBlock[]（完整 upsert 用 messageId 替换；chunk 追加）
        case 'agent_thought':
        case 'agent_thought_chunk':
        case 'agent_message':
        case 'agent_message_chunk':
        case 'user_message':
        case 'user_message_chunk': {
          const isChunk = sessionUpdate.endsWith('_chunk');
          const isUser = sessionUpdate.startsWith('user_');
          const isThought = sessionUpdate.startsWith('agent_thought');
          const messageId =
            asString(update.messageId) ?? `acp_msg_${this.messageState.size}`;
          const key = `${sessionId}#${messageId}`;
          const prev = this.messageState.get(key) ?? { content: '', revision: 0 };
          const rolePart = isUser
            ? { role: 'user' as const }
            : isThought
              ? {}
              : { role: 'assistant' as const };
          // F4-2 清空语义：content 字段缺失=保留原内容；null/[]=清空；非空数组=替换；chunk=追加
          const hasContent = 'content' in update;
          const rawContent = update.content;
          const cleared =
            hasContent &&
            (rawContent == null || (Array.isArray(rawContent) && rawContent.length === 0));
          if (!isChunk) {
            const revision = prev.revision + 1;
            if (cleared) {
              this.messageState.set(key, { content: '', revision });
              // 清空也必须下发 full 覆盖事件（空 delta + full=true = 清空）
              return [
                this.buildEvent(sessionId, isThought ? 'thinking_delta' : 'text_delta', {
                  delta: '',
                  partId: messageId,
                  messageId,
                  partRevision: revision,
                  full: true,
                  ...rolePart,
                }),
              ];
            }
            if (!hasContent) return []; // 字段缺失=保留原内容
            const text = extractText(rawContent);
            this.messageState.set(key, { content: text, revision });
            return [
              this.buildEvent(sessionId, isThought ? 'thinking_delta' : 'text_delta', {
                delta: text,
                partId: messageId,
                messageId,
                partRevision: revision,
                full: true,
                ...rolePart,
              }),
            ];
          }
          const text = extractText(update.content ?? update.delta);
          if (!text) return [];
          const revision = prev.revision + 1;
          this.messageState.set(key, { content: prev.content + text, revision });
          return [
            this.buildEvent(sessionId, isThought ? 'thinking_delta' : 'text_delta', {
              delta: text,
              partId: messageId,
              messageId,
              partRevision: revision,
              ...rolePart,
            }),
          ];
        }

        case 'tool_call': {
          const toolCallId = asString(update.toolCallId) ?? `acp_call_${randomUUID()}`;
          const name = asString(update.title) ?? asString(update.name) ?? 'tool';
          const input = isRecord(update.rawInput)
            ? redactSensitiveData(update.rawInput)
            : isRecord(update.input)
              ? redactSensitiveData(update.input)
              : {};
          this.toolState.set(`${sessionId}#${toolCallId}`, {
            content: '',
            useEmitted: true,
          });
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
          if (!toolCallId) return [];
          const key = `${sessionId}#${toolCallId}`; // toolCallId 按 Session 隔离
          const state = this.toolState.get(key) ?? { content: '', useEmitted: false };
          this.toolState.set(key, state);
          const status = asString(update.status);
          const events: CanonicalAgentEvent[] = [];
          // F4-2：v2 第一个 tool_call_update 即创建工具调用（tool_call 已从 v2 移除）——
          // 每个 (session, toolCallId) 只建一次
          if (!state.useEmitted) {
            state.useEmitted = true;
            const name = asString(update.title) ?? asString(update.name) ?? 'tool';
            const input = isRecord(update.rawInput)
              ? redactSensitiveData(update.rawInput)
              : isRecord(update.input)
                ? redactSensitiveData(update.input)
                : {};
            events.push(
              this.buildEvent(sessionId, 'tool_use', {
                toolCallId,
                name,
                input,
              }),
            );
          }
          // F4-2：tool_call_update.content（ToolCallContent[]）= 整体替换；null/[]=**清空**；
          // 字段缺失=保留；rawOutput（兼容）同样替换。必须按字段存在性判断，!=null 会漏掉清空
          const hasContent = 'content' in update;
          const hasRaw = 'rawOutput' in update;
          if (hasContent) {
            const raw = update.content;
            state.content =
              raw == null || (Array.isArray(raw) && raw.length === 0)
                ? ''
                : extractText(raw);
          } else if (hasRaw) {
            state.content = extractText(update.rawOutput);
          }
          const isTerminal = status === 'completed' || status === 'failed';
          if (isTerminal || hasContent || hasRaw) {
            const { content, truncated } = truncateOutput(state.content, this.maxToolOutputLength);
            events.push(
              this.buildEvent(sessionId, 'tool_result', {
                toolCallId,
                content,
                isError: status === 'failed',
                ...(truncated ? { truncated: true } : {}),
              }),
            );
          }
          return events;
        }

        // F4-2：tool_call_content_chunk.content 为单个 ToolCallContent 对象——追加到现有内容
        case 'tool_call_content_chunk': {
          const toolCallId = asString(update.toolCallId) ?? '';
          const chunkText = extractText(update.content);
          if (!toolCallId || !chunkText) return [];
          const key = `${sessionId}#${toolCallId}`;
          const state = this.toolState.get(key) ?? { content: '', useEmitted: false };
          state.content += chunkText;
          this.toolState.set(key, state);
          const { content, truncated } = truncateOutput(state.content, this.maxToolOutputLength);
          return [
            this.buildEvent(sessionId, 'tool_result', {
              toolCallId,
              content,
              isError: false,
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

/**
 * F4-2：从 ACP v2 真实数据结构提取文本：
 * - 字符串（兼容/降级）
 * - ContentBlock[]：[{type:'text',text}, ...]，非文本块取其 text/uri/path 标注
 * - ToolCallContent 对象：{type:'content', content: ContentBlock}（chunk 单个 / update 数组）
 */
function extractText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractText(item)).join('');
  }
  if (isRecord(value)) {
    const type = asString(value.type);
    if (type === 'content') return extractText(value.content);
    if (type === 'text') return asString(value.text) ?? '';
    // F4-2：diff 不得静默丢——提取变更摘要 + patch 文本
    if (type === 'diff') {
      const changes = Array.isArray(value.changes)
        ? value.changes
            .map((c) =>
              isRecord(c)
                ? `${asString(c.operation) ?? 'modify'} ${asString(c.path) ?? ''}`.trim()
                : '',
            )
            .filter(Boolean)
            .join('; ')
        : '';
      const patch = isRecord(value.patch) ? asString(value.patch.text) ?? '' : '';
      const head = changes ? `[diff ${changes}]` : '[diff]';
      return patch ? `${head}\n${patch}` : head;
    }
    // F4-2：terminal 是 Agent 终端引用——明确标注不支持展示，不静默丢、不假装是文本
    if (type === 'terminal') return '[terminal 输出暂不支持展示]';
    // 未知扩展类型：不假装提取成功
    if (type != null) return `[不支持的内容类型: ${type}]`;
    const wrapper = value.content;
    const direct = asString(value.text);
    if (direct != null) return direct;
    if (wrapper != null) return extractText(wrapper);
    const parts = value.parts;
    if (Array.isArray(parts)) return extractText(parts);
  }
  return '';
}

export type AcpTransport = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(listener: (notification: unknown) => void): () => void;
  close(): Promise<void>;
};

export type AcpAdapterOptions = AcpNormalizerOptions & {
  transport?: AcpTransport | undefined;
  /** F4-1：v1 回落必须走**新连接**（一个连接只协商一个协议版本）——提供重建 transport 的工厂。 */
  reconnect?: (() => Promise<AcpTransport>) | undefined;
  defaultProjectPath?: string | undefined;
};

export class AcpAdapter implements AgentAdapter {
  readonly id = 'acp' as const;
  readonly name = 'ACP Agent';
  readonly capabilities = { ...capabilities };

  private transport: AcpTransport | undefined;
  private readonly reconnect: (() => Promise<AcpTransport>) | undefined;
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
    this.reconnect = options.reconnect;
    this.defaultProjectPath = options.defaultProjectPath ?? process.cwd();
    this.normalizer = new AcpEventNormalizer(options);

    if (this.transport) {
      this.attachTransport(this.transport);
    }
  }

  /** F4-1：统一挂载 transport 通知订阅（初始连接与 fallback 新连接都必须走这里）。 */
  private attachTransport(transport: AcpTransport): void {
    this.unsubscribeTransport?.();
    this.transport = transport;
    this.unsubscribeTransport = transport.onNotification((msg) => {
      for (const evt of this.normalizer.normalize(msg)) {
        for (const listener of this.listeners) listener(evt);
      }
    });
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
        // F4-1：只有 -32022（Unsupported protocol version）才是版本不兼容——
        // -32602/-32600 不是版本信号（官方要求 Agent 先读 protocolVersion 再协商），
        // 网络错误（ECONNRESET 等字符串 code）更不是。一律直接上抛。
        const rawCode = (error as { code?: unknown } | null)?.code;
        if (rawCode !== -32022) {
          throw error;
        }
        // F4-1：按 -32022 的结构化版本信息判断是否真的存在 v1 可选版本——
        // **fail-closed**：supported 缺失/不为数组/不含 1 一律不回落（不得推测 Agent 支持 v1）
        const data = (error as { data?: { requested?: unknown; supported?: unknown } } | null)
          ?.data;
        if (!Array.isArray(data?.supported) || !data!.supported!.includes(1)) {
          throw error;
        }
        // F4-1：一个连接只协商一个协议版本——v1 回落必须**关闭原连接、用新连接**重新协商
        if (!this.reconnect) {
          throw new Error(
            'ACP v2 initialize 被拒（-32022）且未提供 reconnect 工厂，无法在新连接上回落 v1',
          );
        }
        await this.transport?.close();
        // F4-1：新连接必须重新注册通知监听（否则 Agent 的消息/工具/状态更新全部丢失）
        this.attachTransport(await this.reconnect());
        // v1 initialize 使用 clientInfo/clientCapabilities（不是 v2 的 info/capabilities）
        const res = (await this.transport.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'nienie-bridge', title: 'Nienie Bridge', version: '0.1.0' },
          clientCapabilities: {},
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
    // F4-3：恢复优先用会话已有 projectPath，避免向 Agent 传错工作目录
    const known = this.sessions.get(sessionId);
    const cwd = known?.projectPath ?? this.defaultProjectPath;
    if (this.protocolVersion === 2) {
      // F4-B：v2 已移除 session/load，恢复用 session/resume（replayFrom start 重放完整历史）
      await this.transport.request('session/resume', {
        sessionId,
        cwd,
        replayFrom: { type: 'start' },
      });
    } else {
      await this.transport.request('session/load', {
        sessionId,
        cwd,
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
