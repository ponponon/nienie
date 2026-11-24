import type { AgentAdapter } from '@nienie/agent-events';
import type {
  AgentId,
  AgentInfo,
  AgentSession,
  CanonicalAgentEvent,
  CreateSessionInput,
  ModelInfo,
  PermissionDecision,
  SessionFileDiff,
} from '@nienie/protocol';

export class AgentRegistry {
  private readonly adapters = new Map<AgentId, AgentAdapter>();
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => unknown>();
  private readonly unsubscribers = new Map<AgentId, () => void>();
  /**
   * 下游监听器不在时的待发事件缓冲。
   *
   * 真实启动顺序里 Adapter 可能在 BridgeServer 订阅之前就产生事件（注册即订阅的
   * 转发层不能把这些事件发进空监听器集合静默丢掉）。缓冲在第一个下游监听器
   * 注册时补发；容量上限防无限增长，溢出走诊断计数。
   *
   * **PERSIST_FAILED 不进缓冲**：它的可靠送达由 Adapter 侧的 sidecar 磁盘队列
   * 负责（下游接上后 `flushPendingNotices` 重发）——同一条提示不允许既走缓存
   * 又走磁盘队列被送达两次。
   */
  private pendingEvents: CanonicalAgentEvent[] = [];
  private pendingEventsDropped = 0;
  private static readonly MAX_PENDING_EVENTS = 500;

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Agent adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    const unsubscribe = adapter.onEvent((event) => {
      // 没有真正下游监听器时：PERSIST_FAILED 返回 false（Adapter 保留磁盘副本
      // 等重试，不许确认消费 sidecar）；其余事件进缓冲，下游接上后补发。
      if (this.listeners.size === 0) {
        if (isSidecarNoticeEvent(event)) {
          return false;
        }
        this.bufferEvent(event);
        return false;
      }
      let delivered = false;
      for (const listener of this.listeners) {
        if (listener(event) !== false) {
          delivered = true;
        }
      }
      return delivered;
    });
    this.unsubscribers.set(adapter.id, unsubscribe);
  }

  private bufferEvent(event: CanonicalAgentEvent): void {
    this.pendingEvents.push(event);
    if (this.pendingEvents.length > AgentRegistry.MAX_PENDING_EVENTS) {
      this.pendingEvents.shift();
      this.pendingEventsDropped += 1;
    }
  }

  get(agentId: AgentId): AgentAdapter | undefined {
    return this.adapters.get(agentId);
  }

  async detectAll(): Promise<AgentInfo[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.detect()));
  }

  async listSessions(): Promise<AgentSession[]> {
    const sessions = await Promise.all(
      [...this.adapters.values()].map((adapter) =>
        adapter.listSessions().catch(() => [] as AgentSession[]),
      ),
    );
    return sessions.flat();
  }

  async listModels(agentId: AgentId): Promise<ModelInfo[]> {
    const adapter = this.adapters.get(agentId);
    if (!adapter) {
      throw new Error(`No adapter registered for agent: ${agentId}`);
    }
    if (!adapter.listModels) {
      return [];
    }
    return adapter.listModels();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => unknown): () => void {
    this.listeners.add(listener);
    // 补发下游缺席期间缓冲的事件（只补给刚注册的这个监听器，不重复打扰老监听器）
    if (this.pendingEvents.length > 0) {
      const pending = this.pendingEvents;
      this.pendingEvents = [];
      for (const event of pending) {
        listener(event);
      }
    }
    // PERSIST_FAILED 等持久化提示此前被退回 Adapter 等重试：下游到了，重发
    for (const adapter of this.adapters.values()) {
      adapter.flushPendingNotices?.();
    }
    return () => this.listeners.delete(listener);
  }

  /** 聚合各适配器的事件流连接诊断。 */
  getDiagnostics(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, adapter] of this.adapters) {
      if (typeof adapter.getDiagnostics === 'function') {
        try {
          out[id] = adapter.getDiagnostics();
        } catch {
          out[id] = { error: 'diagnostics unavailable' };
        }
      }
    }
    if (this.pendingEventsDropped > 0) {
      out['registryBuffer'] = { droppedEvents: this.pendingEventsDropped };
    }
    return out;
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.values()) {
      unsubscribe();
    }
    this.unsubscribers.clear();
    this.listeners.clear();
    this.pendingEvents = [];
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.dispose()));
  }
}

/** sidecar 持久化提示（PERSIST_FAILED）：由 Adapter 磁盘队列负责重试，不进 Registry 缓冲。 */
function isSidecarNoticeEvent(event: CanonicalAgentEvent): boolean {
  return event.type === 'error' && (event.payload as { code?: unknown } | undefined)?.code === 'PERSIST_FAILED';
}

export class SessionRouter {
  constructor(private readonly registry: AgentRegistry) {}

  async createSession(agentId: AgentId, input?: CreateSessionInput): Promise<AgentSession> {
    const adapter = this.registry.get(agentId);
    if (!adapter) {
      throw new Error(`No adapter registered for agent: ${agentId}`);
    }
    if (!adapter.createSession) {
      throw new Error(`Agent adapter ${agentId} does not support creating sessions`);
    }
    return adapter.createSession(input);
  }

  async loadSession(agentId: AgentId, sessionId: string): Promise<AgentSession> {
    const adapter = this.registry.get(agentId);
    if (!adapter) {
      throw new Error(`No adapter registered for agent: ${agentId}`);
    }
    if (!adapter.loadSession) {
      throw new Error(`Agent adapter ${agentId} does not support loading sessions`);
    }
    return adapter.loadSession(sessionId);
  }

  async getSessionDiff(session: AgentSession): Promise<SessionFileDiff[]> {
    const adapter = this.registry.get(session.agentId);
    if (!adapter) {
      throw new Error(`No adapter registered for agent: ${session.agentId}`);
    }
    if (!adapter.getSessionDiff) {
      return [];
    }
    return adapter.getSessionDiff(session.id);
  }

  /**
   * (sessionId, clientMessageId) → 首次接受结果（R3-2 幂等）：
   * 网络中断后手机重试同一条消息可能触发 Bridge 重复执行——首次正常分发，
   * 重复请求返回第一次的接受结果（进行中的复用同一 Promise），不再启动第二次执行。
   * clientMessageId 为空（旧客户端）不去重。
   * F2：in-flight 与已接受记录分开管理——LRU 只淘汰已完成记录，正在执行的请求绝不淘汰
   *（否则 512 条突发流量会把执行中的幂等记录挤掉，重试导致二次执行）。
   */
  private readonly sendInFlight = new Map<string, Promise<{ messageId?: string | undefined } | void>>();
  private readonly sendAccepted = new Map<string, { messageId?: string | undefined } | void>();

  async sendMessage(
    session: AgentSession,
    message: string,
    modelId?: string,
    clientMessageId?: string,
  ): Promise<{ messageId?: string | undefined } | void> {
    const adapter = this.registry.get(session.agentId);
    if (!adapter) {
      throw new Error(`No adapter registered for agent: ${session.agentId}`);
    }
    const key = clientMessageId ? `${session.id}::${clientMessageId}` : null;
    if (key) {
      const inFlight = this.sendInFlight.get(key);
      if (inFlight) {
        return await inFlight;
      }
      if (this.sendAccepted.has(key)) {
        const accepted = this.sendAccepted.get(key);
        // LRU 触达刷新
        this.sendAccepted.delete(key);
        this.sendAccepted.set(key, accepted);
        return accepted;
      }
    }
    const run = (async () =>
      await adapter.sendMessage(
        session.id,
        message,
        modelId || clientMessageId
          ? { ...(modelId ? { modelId } : {}), ...(clientMessageId ? { clientMessageId } : {}) }
          : undefined,
      ) ?? undefined)();
    if (key) {
      this.sendInFlight.set(key, run);
      void run.then(
        (result) => {
          this.sendInFlight.delete(key!);
          this.sendAccepted.set(key!, result);
          // 只在已完成记录间做 LRU（in-flight 不参与淘汰）
          if (this.sendAccepted.size > 512) {
            const oldest = this.sendAccepted.keys().next();
            if (!oldest.done) this.sendAccepted.delete(oldest.value);
          }
        },
        () => {
          this.sendInFlight.delete(key!); // 失败不缓存（允许真正重试）
        },
      );
    }
    return await run;
  }

  async cancel(session: AgentSession): Promise<void> {
    const adapter = this.registry.get(session.agentId);
    if (!adapter) {
      throw new Error(`No adapter registered for agent: ${session.agentId}`);
    }
    await adapter.cancel(session.id);
  }

  async replyPermission(
    session: AgentSession,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const adapter = this.registry.get(session.agentId);
    if (!adapter) {
      throw new Error(`No adapter registered for agent: ${session.agentId}`);
    }
    if (!adapter.replyPermission) {
      throw new Error(`Agent adapter ${session.agentId} does not support permission replies`);
    }
    await adapter.replyPermission(session.id, permissionId, decision);
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    return this.registry.onEvent(listener);
  }
}

export {
  CustomJsonlAdapter,
  redactLogText,
  type CustomJsonlAdapterOptions,
} from '@nienie/agent-events';
export {
  decodePairingQrPayload,
  decryptRelayPayload,
  DEFAULT_RELAY_URL,
  encodePairingQrPayload,
  encryptRelayPayload,
  resolveRelayUrl,
  type AgentId,
  type AgentInfo,
  type AgentSession,
  type BridgeRequest,
  type BridgeResponse,
  type CanonicalAgentEvent,
  type CreateSessionInput,
  type EncryptedRelayPayload,
  type PairedDevice,
  type PairingQrPayload,
  type PermissionDecision,
  type RelayWireMessage,
  type ScreenCaptureFrame,
} from '@nienie/protocol';
export {
  BridgeServer,
  type BridgeServerAddress,
  type BridgeServerOptions,
  type ScreenCaptureProvider,
} from './ws-server.js';
export {
  PairingManager,
  type ConfirmPairingInput,
  type ConfirmPairingResult,
  type PairingChallenge,
  type PairingManagerOptions,
} from './pairing.js';
export {
  BridgeRelayClient,
  RelayServer,
  type BridgeRelayClientOptions,
  type RelayServerOptions,
} from './relay.js';
export {
  HeadlessBridgeDaemon,
  type HeadlessBridgeDaemonOptions,
  type HeadlessDaemonStatus,
} from './daemon.js';
export {
  BarkPushSender,
  createPushSender,
  DEFAULT_PUSH_PREFERENCES,
  isWithinQuietHours,
  NtfyPushSender,
  PushNotificationRouter,
  sanitizePushBody,
  validateWebhookUrl,
  WebhookPushSender,
  type PushNotificationMessage,
  type PushNotificationPreferences,
  type PushNotificationRouterOptions,
  type PushRegistration,
  type PushSender,
  type PushSenderType,
} from './push.js';
export {
  runDaemonCli,
  runRelayCli,
  type DaemonCliHandle,
  type RelayCliHandle,
} from './cli.js';
export {
  QuicP2PNode,
  toArrayBuffer,
  createServerCrypto,
  clientCrypto,
  buildServerConfig,
  buildClientConfig,
  type PeerEndpoint,
  type P2PConnection,
  type PunchOptions,
  type ConnectOptions,
  type QuicP2PNodeOptions,
  type QuicTlsConfig,
  type P2PMessageHandler,
} from './quic-p2p.js';
export {
  raceTransports,
  type TransportKind,
  type TransportCandidate,
  type RaceOptions,
} from './connection-racer.js';
