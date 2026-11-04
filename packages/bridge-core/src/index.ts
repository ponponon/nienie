import type { AgentAdapter } from '@nienie/agent-events';
import type {
  AgentId,
  AgentInfo,
  AgentSession,
  CanonicalAgentEvent,
  CreateSessionInput,
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
    const sessions = await Promise.all([...this.adapters.values()].map((adapter) => adapter.listSessions()));
    return sessions.flat();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  async sendMessage(session: AgentSession, message: string): Promise<void> {
    const adapter = this.registry.get(session.agentId);
    if (!adapter) {
      throw new Error(`No adapter registered for agent: ${session.agentId}`);
    }
    await adapter.sendMessage(session.id, message);
  }

  async cancel(session: AgentSession): Promise<void> {
    const adapter = this.registry.get(session.agentId);
    if (!adapter) {
      throw new Error(`No adapter registered for agent: ${session.agentId}`);
    }
    await adapter.cancel(session.id);
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    return this.registry.onEvent(listener);
  }
}

export {
  BridgeServer,
  type BridgeServerAddress,
  type BridgeServerOptions,
} from './ws-server.js';
