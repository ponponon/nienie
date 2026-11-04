import type { AgentCapabilities, AgentId, AgentInfo, CanonicalAgentEvent } from '@nienie/protocol';

export type AgentAdapter = {
  readonly id: AgentId;
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  detect(): Promise<AgentInfo>;
  listSessions(): Promise<never[]>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void;
};

export function createAgentInfo(
  adapter: Pick<AgentAdapter, 'id' | 'name' | 'capabilities'>,
  available: boolean,
): AgentInfo {
  return { id: adapter.id, name: adapter.name, available, capabilities: adapter.capabilities };
}
