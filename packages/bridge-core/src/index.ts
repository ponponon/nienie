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
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly unsubscribers = new Map<AgentId, () => void>();

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Agent adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    const unsubscribe = adapter.onEvent((event) => {
      for (const listener of this.listeners) {
        listener(event);
      }
    });
    this.unsubscribers.set(adapter.id, unsubscribe);
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

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
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
    return out;
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.values()) {
      unsubscribe();
    }
    this.unsubscribers.clear();
    this.listeners.clear();
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.dispose()));
  }
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
   */
  private readonly sendDedup = new Map<string, Promise<{ messageId?: string | undefined } | void>>();

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
      const existing = this.sendDedup.get(key);
      if (existing) {
        return await existing;
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
      this.sendDedup.set(key, run);
      // 失败不缓存（允许真正重试）；成功结果保留供重复请求回放
      run.catch(() => this.sendDedup.delete(key!));
      // LRU 上限防无界增长
      if (this.sendDedup.size > 512) {
        const oldest = this.sendDedup.keys().next();
        if (!oldest.done) this.sendDedup.delete(oldest.value);
      }
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
