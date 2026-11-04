import type { AgentAdapter } from '@nienie/agent-events';
import type { AgentId, AgentInfo, AgentSession } from '@nienie/protocol';

export class AgentRegistry {
  private readonly adapters = new Map<AgentId, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Agent adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(agentId: AgentId): AgentAdapter | undefined { return this.adapters.get(agentId); }

  async detectAll(): Promise<AgentInfo[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.detect()));
  }

  async listSessions(): Promise<AgentSession[]> {
    const sessions = await Promise.all([...this.adapters.values()].map((adapter) => adapter.listSessions()));
    return sessions.flat();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.dispose()));
  }
}

export class SessionRouter {
  constructor(private readonly registry: AgentRegistry) {}

  async sendMessage(session: AgentSession, message: string): Promise<void> {
    const adapter = this.registry.get(session.agentId);
    if (!adapter) throw new Error(`No adapter registered for agent: ${session.agentId}`);
    await adapter.sendMessage(session.id, message);
  }

  async cancel(session: AgentSession): Promise<void> {
    const adapter = this.registry.get(session.agentId);
    if (!adapter) throw new Error(`No adapter registered for agent: ${session.agentId}`);
    await adapter.cancel(session.id);
  }
}
