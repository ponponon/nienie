import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  createAgentInfo,
  createCanonicalEvent,
  type AgentAdapter,
} from '@nienie/agent-events';
import type {
  AgentSession,
  CanonicalAgentEvent,
  CanonicalAgentEventType,
  CreateSessionInput,
} from '@nienie/protocol';

const ANSI_ESCAPE_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsiSequences(input: string): string {
  return input.replace(ANSI_ESCAPE_REGEX, '');
}

const capabilities = {
  streaming: true,
  thinking: false,
  toolCalls: false,
  fileChanges: false,
  permissionRequests: false,
  modelSwitch: false,
  sessionResume: false,
  cancel: true,
} as const;

export type PtySessionHandle = {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
};

export type PtyFallbackAdapterOptions = {
  machineId?: string | undefined;
  spawnPty?: ((cwd: string) => PtySessionHandle) | undefined;
};

export class PtyFallbackAdapter implements AgentAdapter {
  readonly id = 'pty' as const;
  readonly name = 'PTY Terminal Fallback';
  readonly capabilities = { ...capabilities };

  private readonly machineId: string | undefined;
  private readonly spawnPty: ((cwd: string) => PtySessionHandle) | undefined;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly handles = new Map<string, PtySessionHandle>();
  private readonly sequences = new Map<string, number>();

  constructor(options: PtyFallbackAdapterOptions = {}) {
    this.machineId = options.machineId;
    this.spawnPty = options.spawnPty;
  }

  async detect() {
    return createAgentInfo(this, Boolean(this.spawnPty));
  }

  async listSessions(): Promise<AgentSession[]> {
    return [...this.sessions.values()];
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    if (!this.spawnPty) {
      throw new Error('PTY spawner is not configured');
    }
    const id = `pty_ses_${randomUUID()}`;
    const cwd = input.projectPath ?? process.cwd();
    const handle = this.spawnPty(cwd);
    this.handles.set(id, handle);

    const nowIso = new Date().toISOString();
    const session: AgentSession = {
      id,
      agentId: 'pty',
      title: input.title ?? 'PTY Session',
      projectPath: cwd,
      status: 'running',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(id, session);

    handle.stdout.on('data', (chunk: Buffer | string) => {
      const cleaned = stripAnsiSequences(chunk.toString());
      if (cleaned) {
        this.emitEvent(id, 'text_delta', { delta: cleaned });
      }
    });

    handle.onExit((code) => {
      this.handles.delete(id);
      session.status = code === 0 ? 'idle' : 'failed';
      this.emitEvent(id, 'status', {
        status: session.status,
        detail: `PTY exited with code ${String(code)}`,
      });
    });

    return session;
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      throw new Error(`PTY session is not active: ${sessionId}`);
    }
    handle.stdin.write(`${message}\n`);
  }

  async cancel(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (handle) {
      handle.kill();
      this.handles.delete(sessionId);
    }
  }

  async dispose(): Promise<void> {
    for (const handle of this.handles.values()) {
      handle.kill();
    }
    this.handles.clear();
    this.listeners.clear();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitEvent(
    sessionId: string,
    type: CanonicalAgentEventType,
    payload: Record<string, unknown>,
  ): void {
    const nextSeq = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, nextSeq);
    const evt = createCanonicalEvent({
      eventId: `evt_${randomUUID()}`,
      machineId: this.machineId,
      agentId: 'pty',
      sessionId,
      sequence: nextSeq,
      timestamp: new Date().toISOString(),
      type,
      payload,
    });
    for (const listener of this.listeners) listener(evt);
  }
}
