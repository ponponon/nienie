export const PROTOCOL_VERSION = 1 as const;

export type AgentId = 'opencode' | 'codex';
export type AgentStatus = 'starting' | 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type AgentCapabilities = {
  streaming: boolean;
  thinking: boolean;
  toolCalls: boolean;
  fileChanges: boolean;
  permissionRequests: boolean;
  modelSwitch: boolean;
  sessionResume: boolean;
  cancel: boolean;
};

export type AgentInfo = {
  id: AgentId;
  name: string;
  available: boolean;
  version?: string;
  capabilities: AgentCapabilities;
};

export type AgentSession = {
  id: string;
  agentId: AgentId;
  title: string;
  projectPath: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalAgentEvent = {
  version: typeof PROTOCOL_VERSION;
  eventId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: 'status' | 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'usage' | 'error';
  payload: Record<string, unknown>;
};

export type BridgeRequest =
  | { type: 'hello'; requestId: string; protocolVersion: typeof PROTOCOL_VERSION }
  | { type: 'agents.list'; requestId: string }
  | { type: 'sessions.list'; requestId: string }
  | { type: 'session.send'; requestId: string; sessionId: string; message: string };

export type BridgeResponse =
  | { type: 'response'; requestId: string; ok: true; data: unknown }
  | { type: 'response'; requestId: string; ok: false; error: { code: string; message: string } }
  | { type: 'session.event'; event: CanonicalAgentEvent };
