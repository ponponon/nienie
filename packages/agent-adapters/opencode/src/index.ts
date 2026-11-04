import { createAgentInfo, type AgentAdapter } from '@nienie/agent-events';
import type { CanonicalAgentEvent } from '@nienie/protocol';

const capabilities = {
  streaming: true, thinking: true, toolCalls: true, fileChanges: true,
  permissionRequests: true, modelSwitch: true, sessionResume: true, cancel: true,
} as const;

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode' as const;
  readonly name = 'OpenCode';
  readonly capabilities = { ...capabilities };
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();

  async detect() { return createAgentInfo(this, false); }
  async listSessions() { return []; }
  async sendMessage(_sessionId: string, _message: string): Promise<void> {
    throw new Error('OpenCode adapter transport is not implemented yet');
  }
  async cancel(_sessionId: string): Promise<void> {
    throw new Error('OpenCode adapter transport is not implemented yet');
  }
  async dispose(): Promise<void> { this.listeners.clear(); }
  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
