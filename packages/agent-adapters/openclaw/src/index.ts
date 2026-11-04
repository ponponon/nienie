import { randomUUID } from 'node:crypto';
import {
  createAgentInfo,
  createCanonicalEvent,
  redactSensitiveData,
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
  fileChanges: false,
  permissionRequests: false,
  modelSwitch: true,
  sessionResume: true,
  cancel: true,
} as const;

export type OpenClawAdapterOptions = {
  baseUrl?: string | undefined;
  machineId?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

export class OpenClawAdapter implements AgentAdapter {
  readonly id = 'openclaw' as const;
  readonly name = 'OpenClaw';
  readonly capabilities = { ...capabilities };

  private readonly baseUrl: string;
  private readonly machineId: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sequences = new Map<string, number>();

  constructor(options: OpenClawAdapterOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.NIENIE_OPENCLAW_URL ??
      'http://127.0.0.1:4310'
    ).replace(/\/+$/, '');
    this.machineId = options.machineId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async detect() {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`);
      if (!res.ok) return createAgentInfo(this, false);
      const data = (await res.json()) as { ok?: boolean; version?: string };
      return createAgentInfo(this, Boolean(data.ok), data.version);
    } catch {
      return createAgentInfo(this, false);
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions`);
    if (!res.ok) throw new Error(`OpenClaw listSessions failed (${res.status})`);
    const list = (await res.json()) as Array<{
      id: string;
      title?: string;
      projectPath?: string;
    }>;
    const nowIso = new Date().toISOString();
    return list.map((item) => ({
      id: item.id,
      agentId: 'openclaw' as const,
      title: item.title ?? 'OpenClaw Session',
      projectPath: item.projectPath ?? '',
      status: 'idle' as const,
      createdAt: nowIso,
      updatedAt: nowIso,
    }));
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`OpenClaw createSession failed (${res.status})`);
    const item = (await res.json()) as { id: string; title?: string; projectPath?: string };
    const nowIso = new Date().toISOString();
    return {
      id: item.id,
      agentId: 'openclaw',
      title: item.title ?? input.title ?? 'OpenClaw Session',
      projectPath: item.projectPath ?? input.projectPath ?? '',
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(`OpenClaw session not found: ${sessionId}`);
    const item = (await res.json()) as { id: string; title?: string; projectPath?: string };
    const nowIso = new Date().toISOString();
    return {
      id: item.id,
      agentId: 'openclaw',
      title: item.title ?? 'OpenClaw Session',
      projectPath: item.projectPath ?? '',
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      },
    );
    if (!res.ok) throw new Error(`OpenClaw sendMessage failed (${res.status})`);
    const body = (await res.json()) as {
      events?: Array<{
        type: CanonicalAgentEventType;
        payload: Record<string, unknown>;
      }>;
    };
    for (const raw of body.events ?? []) {
      const nextSeq = (this.sequences.get(sessionId) ?? 0) + 1;
      this.sequences.set(sessionId, nextSeq);
      const evt = createCanonicalEvent({
        eventId: `evt_${randomUUID()}`,
        machineId: this.machineId,
        agentId: 'openclaw',
        sessionId,
        sequence: nextSeq,
        timestamp: new Date().toISOString(),
        type: raw.type,
        payload: redactSensitiveData(raw.payload),
      });
      for (const listener of this.listeners) listener(evt);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.fetchImpl(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { method: 'POST' },
    );
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
