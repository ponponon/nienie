import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

const capabilities = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  fileChanges: true,
  permissionRequests: false,
  modelSwitch: true,
  sessionResume: true,
  cancel: true,
} as const;

export type PiNormalizerOptions = {
  machineId?: string | undefined;
  maxToolOutputLength?: number | undefined;
  now?: (() => Date) | undefined;
  idGenerator?: (() => string) | undefined;
  streamEpoch?: string | undefined;
};

type RawRecord = Record<string, unknown>;

export class PiEventNormalizer {
  private readonly machineId: string | undefined;
  private readonly maxToolOutputLength: number;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly sequences = new Map<string, number>();
  readonly streamEpoch: string;

  constructor(options: PiNormalizerOptions = {}) {
    this.machineId = options.machineId;
    this.streamEpoch = options.streamEpoch ?? generateStreamEpoch();
    this.maxToolOutputLength = options.maxToolOutputLength ?? DEFAULT_MAX_TOOL_OUTPUT_LENGTH;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => `evt_${randomUUID()}`);
  }

  normalize(sessionId: string, rawInput: unknown): CanonicalAgentEvent[] {
    if (!isRecord(rawInput) || typeof rawInput.type !== 'string') {
      return [];
    }

    switch (rawInput.type) {
      case 'agent_start':
        return [
          this.buildEvent(sessionId, 'status', {
            status: 'running',
            detail: 'Pi agent started',
          }),
        ];

      case 'message_update': {
        const sub = isRecord(rawInput.assistantMessageEvent)
          ? rawInput.assistantMessageEvent
          : rawInput;
        const subType = asString(sub.type);
        const delta = asString(sub.delta) ?? '';
        if (!delta) return [];
        if (subType === 'thinking_delta') {
          return [this.buildEvent(sessionId, 'thinking_delta', { delta })];
        }
        if (subType === 'text_delta') {
          return [this.buildEvent(sessionId, 'text_delta', { delta })];
        }
        return [];
      }

      case 'tool_execution_start': {
        const toolCallId = asString(rawInput.toolCallId) ?? `pi_call_${randomUUID()}`;
        const name = asString(rawInput.toolName) ?? 'tool';
        const input = isRecord(rawInput.args) ? redactSensitiveData(rawInput.args) : {};
        return [
          this.buildEvent(sessionId, 'tool_use', {
            toolCallId,
            name,
            input,
          }),
        ];
      }

      case 'tool_execution_end': {
        const toolCallId = asString(rawInput.toolCallId) ?? '';
        if (!toolCallId) return [];
        const rawResult =
          typeof rawInput.result === 'string'
            ? rawInput.result
            : JSON.stringify(rawInput.result ?? '');
        const { content, truncated } = truncateOutput(rawResult, this.maxToolOutputLength);
        return [
          this.buildEvent(sessionId, 'tool_result', {
            toolCallId,
            content,
            isError: Boolean(rawInput.isError),
            ...(truncated ? { truncated: true } : {}),
          }),
        ];
      }

      case 'agent_end': {
        const events: CanonicalAgentEvent[] = [];
        const usage = isRecord(rawInput.usage) ? rawInput.usage : undefined;
        if (usage) {
          events.push(
            this.buildEvent(sessionId, 'usage', {
              inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
              outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
              costUsd: typeof usage.costUsd === 'number' ? usage.costUsd : 0,
            }),
          );
        }
        events.push(
          this.buildEvent(sessionId, 'status', {
            status: 'idle',
            detail: 'Pi agent completed',
          }),
        );
        return events;
      }

      case 'error':
        return [
          this.buildEvent(sessionId, 'error', {
            code: 'PI_EXECUTION_FAILED',
            message: asString(rawInput.message) ?? 'Pi execution failed',
            retryable: false,
          }),
        ];

      default:
        return [];
    }
  }

  private buildEvent(
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
      agentId: 'pi',
      sessionId,
      sequence: nextSeq,
      timestamp: this.now().toISOString(),
      type,
      payload,
    });
  }
}

export type PiProcessHandle = {
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
};

export type PiAdapterOptions = PiNormalizerOptions & {
  executablePath?: string | undefined;
  defaultProjectPath?: string | undefined;
  detectVersion?: (() => Promise<string>) | undefined;
  spawnProcess?:
    | ((args: string[], options: { cwd?: string | undefined }) => PiProcessHandle)
    | undefined;
};

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  readonly name = 'Pi';
  readonly capabilities = { ...capabilities };

  private readonly executablePath: string;
  private readonly defaultProjectPath: string;
  private readonly detectVersionImpl: () => Promise<string>;
  private readonly spawnProcessImpl: (
    args: string[],
    options: { cwd?: string | undefined },
  ) => PiProcessHandle;
  private readonly normalizer: PiEventNormalizer;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly activeProcesses = new Map<string, PiProcessHandle>();

  constructor(options: PiAdapterOptions = {}) {
    this.executablePath = options.executablePath ?? process.env.NIENIE_PI_BIN ?? 'pi';
    this.defaultProjectPath = options.defaultProjectPath ?? process.cwd();
    this.normalizer = new PiEventNormalizer(options);

    this.detectVersionImpl =
      options.detectVersion ??
      (async () => {
        const { stdout } = await execFileAsync(this.executablePath, ['--version'], {
          timeout: 3000,
        });
        return stdout.trim();
      });

    this.spawnProcessImpl =
      options.spawnProcess ??
      ((args, spawnOpts) => {
        const child = spawn(this.executablePath, args, {
          cwd: spawnOpts.cwd || this.defaultProjectPath,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return {
          stdout: child.stdout,
          stderr: child.stderr,
          kill() {
            child.kill('SIGTERM');
          },
          onExit(listener) {
            child.once('exit', (code) => listener(code));
          },
          onError(listener) {
            child.once('error', (err) => listener(err));
          },
        };
      });
  }

  async detect() {
    try {
      const raw = await this.detectVersionImpl();
      if (!raw) return createAgentInfo(this, false);
      const match = raw.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      return createAgentInfo(this, true, match?.[1] ?? raw);
    } catch {
      return createAgentInfo(this, false);
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    return [...this.sessions.values()];
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const nowIso = new Date().toISOString();
    const session: AgentSession = {
      id: `pi_ses_${randomUUID()}`,
      agentId: 'pi',
      title: input.title?.trim() || 'Pi Session',
      projectPath: input.projectPath?.trim() || this.defaultProjectPath,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const nowIso = new Date().toISOString();
    const session: AgentSession = {
      id: sessionId,
      agentId: 'pi',
      title: `Pi Session ${sessionId.slice(0, 8)}`,
      projectPath: this.defaultProjectPath,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = await this.loadSession(sessionId);
    }

    const args = ['--mode', 'json', '--session', sessionId, '-p', message];
    const proc = this.spawnProcessImpl(args, { cwd: session.projectPath });
    this.activeProcesses.set(sessionId, proc);

    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          this.processLine(sessionId, line);
        }
      });
      proc.onError((err) => {
        this.activeProcesses.delete(sessionId);
        reject(err);
      });
      proc.onExit(() => {
        if (buffer.trim()) {
          this.processLine(sessionId, buffer);
        }
        this.activeProcesses.delete(sessionId);
        resolve();
      });
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      proc.kill();
      this.activeProcesses.delete(sessionId);
    }
  }

  async dispose(): Promise<void> {
    for (const proc of this.activeProcesses.values()) {
      proc.kill();
    }
    this.activeProcesses.clear();
    this.listeners.clear();
  }

  onEvent(listener: (event: CanonicalAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private processLine(sessionId: string, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      for (const evt of this.normalizer.normalize(sessionId, parsed)) {
        for (const listener of this.listeners) listener(evt);
      }
    } catch {
      // Ignore non-JSON lines
    }
  }
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
