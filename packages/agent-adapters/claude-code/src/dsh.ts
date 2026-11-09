import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  createAgentInfo,
  createCanonicalEvent,
  DEFAULT_MAX_TOOL_OUTPUT_LENGTH,
  generateStreamEpoch,
  redactSensitiveData,
  truncateOutput,
  type AgentAdapter,
} from '@nienie/agent-events';
import type {
  AgentSession,
  AgentStatus,
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
  modelSwitch: false,
  sessionResume: true,
  cancel: true,
} as const;

export type DshNormalizerOptions = {
  machineId?: string | undefined;
  maxToolOutputLength?: number | undefined;
  now?: (() => Date) | undefined;
  idGenerator?: (() => string) | undefined;
  /** 事件流实例标识；缺省时生成。 */
  streamEpoch?: string | undefined;
};

type RawRecord = Record<string, unknown>;

export class DshEventNormalizer {
  private readonly machineId: string | undefined;
  readonly streamEpoch: string;
  private readonly maxToolOutputLength: number;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  private readonly sequences = new Map<string, number>();
  private readonly dshSessionIds = new Map<string, string>();
  private readonly sessionStatuses = new Map<string, AgentStatus>();
  private readonly turnHasText = new Map<string, boolean>();

  constructor(options: DshNormalizerOptions = {}) {
    this.machineId = options.machineId;
    this.streamEpoch = options.streamEpoch ?? generateStreamEpoch();
    this.maxToolOutputLength = options.maxToolOutputLength ?? DEFAULT_MAX_TOOL_OUTPUT_LENGTH;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => `evt_${randomUUID()}`);
  }

  nextSequence(sessionId: string): number {
    const nextSeq = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, nextSeq);
    return nextSeq;
  }

  getDshSessionId(sessionId: string): string | undefined {
    return this.dshSessionIds.get(sessionId);
  }

  getSessionStatus(sessionId: string): AgentStatus | undefined {
    return this.sessionStatuses.get(sessionId);
  }

  normalize(sessionId: string, rawInput: unknown): CanonicalAgentEvent[] {
    if (!isRecord(rawInput) || typeof rawInput.type !== 'string') {
      return [];
    }

    switch (rawInput.type) {
      case 'session': {
        const remoteId = asString(rawInput.sessionId);
        if (remoteId) {
          this.dshSessionIds.set(sessionId, remoteId);
        }
        return [];
      }

      case 'status': {
        const phase = asString(rawInput.phase);
        if (phase === 'turn_start') {
          this.turnHasText.set(sessionId, false);
          this.sessionStatuses.set(sessionId, 'running');
          return [
            this.buildEvent(sessionId, 'status', {
              status: 'running',
              detail: 'DeepSeek Harness turn started',
            }),
          ];
        }

        if (phase === 'step_end') {
          const usage = isRecord(rawInput.usage) ? rawInput.usage : undefined;
          if (!usage) return [];
          return [
            this.buildEvent(sessionId, 'usage', {
              inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
              outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
              costUsd: 0,
            }),
          ];
        }

        if (phase === 'turn_end') {
          const reason = isRecord(rawInput.reason) ? rawInput.reason : undefined;
          if (reason && asString(reason.kind) === 'error') {
            this.sessionStatuses.set(sessionId, 'failed');
            const errObj = isRecord(reason.error) ? reason.error : undefined;
            return [
              this.buildEvent(sessionId, 'error', {
                code: asString(errObj?.code) ?? 'DSH_EXECUTION_FAILED',
                message: asString(errObj?.message) ?? 'DeepSeek Harness turn failed',
                retryable: false,
              }),
            ];
          }
          this.sessionStatuses.set(sessionId, 'idle');
          return [
            this.buildEvent(sessionId, 'status', {
              status: 'idle',
              detail: 'DeepSeek Harness turn completed',
            }),
          ];
        }

        return [];
      }

      case 'thinking': {
        const delta = asString(rawInput.text) ?? '';
        if (!delta) return [];
        return [this.buildEvent(sessionId, 'thinking_delta', { delta })];
      }

      case 'text': {
        const delta = asString(rawInput.text) ?? '';
        if (!delta) return [];
        this.turnHasText.set(sessionId, true);
        return [this.buildEvent(sessionId, 'text_delta', { delta })];
      }

      case 'tool_call': {
        const toolCallId = asString(rawInput.callId) ?? `call_${randomUUID()}`;
        const name = asString(rawInput.tool) ?? 'tool';
        const input = isRecord(rawInput.input) ? redactSensitiveData(rawInput.input) : {};
        return [
          this.buildEvent(sessionId, 'tool_use', {
            toolCallId,
            name,
            input,
          }),
        ];
      }

      case 'tool_result': {
        const toolCallId = asString(rawInput.callId) ?? '';
        if (!toolCallId) return [];
        const rawContent = asString(rawInput.result) ?? '';
        const { content, truncated } = truncateOutput(rawContent, this.maxToolOutputLength);
        const isError = asString(rawInput.status) === 'error';
        return [
          this.buildEvent(sessionId, 'tool_result', {
            toolCallId,
            content,
            isError,
            ...(truncated ? { truncated: true } : {}),
          }),
        ];
      }

      case 'final': {
        const finalText = asString(rawInput.text) ?? '';
        if (finalText && !this.turnHasText.get(sessionId)) {
          this.turnHasText.set(sessionId, true);
          return [this.buildEvent(sessionId, 'text_delta', { delta: finalText })];
        }
        return [];
      }

      default:
        return [];
    }
  }

  private buildEvent(
    sessionId: string,
    type: CanonicalAgentEventType,
    payload: Record<string, unknown>,
  ): CanonicalAgentEvent {
    const nextSeq = this.nextSequence(sessionId);

    return createCanonicalEvent({
      eventId: this.idGenerator(),
      streamEpoch: this.streamEpoch,
      machineId: this.machineId,
      agentId: 'dsh',
      sessionId,
      sequence: nextSeq,
      timestamp: this.now().toISOString(),
      type,
      payload,
    });
  }
}

export type DshProcessHandle = {
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
};

export type DshAdapterOptions = DshNormalizerOptions & {
  executablePath?: string | undefined;
  defaultProjectPath?: string | undefined;
  detectVersion?: (() => Promise<string>) | undefined;
  spawnProcess?:
    | ((args: string[], options: { cwd?: string | undefined }) => DshProcessHandle)
    | undefined;
};

type DshSessionRecord = AgentSession & {
  dshSessionId?: string | undefined;
};

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh' as const;
  readonly name = 'DeepSeek Harness';
  readonly capabilities = { ...capabilities };

  private readonly executablePath: string;
  private readonly defaultProjectPath: string;
  private readonly detectVersionImpl: () => Promise<string>;
  private readonly spawnProcessImpl: (
    args: string[],
    options: { cwd?: string | undefined },
  ) => DshProcessHandle;
  private readonly normalizer: DshEventNormalizer;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sessions = new Map<string, DshSessionRecord>();
  private readonly activeProcesses = new Map<string, DshProcessHandle>();
  private readonly discoverLocalHistory: boolean;
  private historyLoaded = false;

  constructor(options: DshAdapterOptions = {}) {
    this.executablePath = resolveDshBinary(
      options.executablePath ?? process.env.NIENIE_DSH_BIN,
    );
    this.defaultProjectPath = options.defaultProjectPath ?? process.cwd();
    this.normalizer = new DshEventNormalizer(options);
    this.discoverLocalHistory = !options.spawnProcess && !options.detectVersion;

    this.detectVersionImpl =
      options.detectVersion ??
      (async () => {
        const { stdout } = await execFileAsync(this.executablePath, ['--version'], {
          timeout: 4000,
          env: buildDshEnv(this.executablePath),
        });
        return stdout.trim();
      });

    this.spawnProcessImpl =
      options.spawnProcess ??
      ((args, spawnOpts) => {
        const child = spawn(this.executablePath, args, {
          cwd: spawnOpts.cwd || this.defaultProjectPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildDshEnv(this.executablePath),
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
    if (this.discoverLocalHistory && !this.historyLoaded) {
      this.historyLoaded = true;
      this.loadLocalDshHistory();
    }
    return [...this.sessions.values()];
  }

  private loadLocalDshHistory(): void {
    const cacheDir = join(homedir(), '.dsh/storages/session_projcache/sessions');
    if (existsSync(cacheDir)) {
      try {
        for (const file of readdirSync(cacheDir)) {
          if (!file.endsWith('.json')) continue;
          const sesId = file.replace(/\.json$/, '');
          if (this.sessions.has(sesId)) continue;
          try {
            const raw = JSON.parse(readFileSync(join(cacheDir, file), 'utf8')) as {
              record?: {
                identity?: { createdAt?: number; cwd?: string };
                rows?: { title?: { val?: string | null } };
              };
            };
            const title = raw.record?.rows?.title?.val?.trim();
            const cwd = raw.record?.identity?.cwd?.trim() || this.defaultProjectPath;
            if (!title) continue;
            const createdAt = raw.record?.identity?.createdAt
              ? new Date(raw.record.identity.createdAt).toISOString()
              : new Date().toISOString();
            this.sessions.set(sesId, {
              id: sesId,
              dshSessionId: sesId,
              agentId: 'dsh',
              title,
              projectPath: cwd,
              status: 'idle',
              createdAt,
              updatedAt: createdAt,
            });
          } catch {
            // Ignore malformed cache file
          }
        }
        return;
      } catch {
        // Fall through
      }
    }
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const nowIso = new Date().toISOString();
    const record: DshSessionRecord = {
      id: `dsh_ses_${randomUUID()}`,
      agentId: 'dsh',
      title: input.title?.trim() || 'DeepSeek Harness Session',
      projectPath: input.projectPath?.trim() || this.defaultProjectPath,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const nowIso = new Date().toISOString();
    const record: DshSessionRecord = {
      id: sessionId,
      dshSessionId: sessionId.startsWith('session-') ? sessionId : undefined,
      agentId: 'dsh',
      title: `DSH Session ${sessionId.slice(0, 8)}`,
      projectPath: this.defaultProjectPath,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    let record = this.sessions.get(sessionId);
    if (!record) {
      await this.loadSession(sessionId);
      record = this.sessions.get(sessionId)!;
    }

    const remoteId = record.dshSessionId ?? this.normalizer.getDshSessionId(sessionId);
    const args = remoteId
      ? ['--profile', 'headless', '--json', '--session-id', remoteId, message]
      : ['--profile', 'headless', '--json', message];

    const proc = this.spawnProcessImpl(args, { cwd: record.projectPath });
    this.activeProcesses.set(sessionId, proc);

    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          this.processLine(sessionId, record!, line);
        }
      });
      proc.onError((err) => {
        this.activeProcesses.delete(sessionId);
        reject(err);
      });
      proc.onExit(() => {
        if (buffer.trim()) {
          this.processLine(sessionId, record!, buffer);
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

  private processLine(sessionId: string, record: DshSessionRecord, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const events = this.normalizer.normalize(sessionId, parsed);
      const boundId = this.normalizer.getDshSessionId(sessionId);
      if (boundId) record.dshSessionId = boundId;
      for (const evt of events) {
        for (const listener of this.listeners) listener(evt);
      }
    } catch {
      // Ignore non-JSON lines
    }
  }
}

function resolveDshBinary(explicit?: string): string {
  if (explicit) return explicit;
  const home = homedir();
  const candidates = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'),
    join(home, '.bun/bin/dsh'),
    join(home, '.local/bin/dsh'),
    '/opt/homebrew/bin/dsh',
    '/usr/local/bin/dsh',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const nvmDir = join(home, '.nvm/versions/node');
  if (existsSync(nvmDir)) {
    try {
      const versions = readdirSync(nvmDir).sort().reverse();
      for (const ver of versions) {
        const binPath = join(nvmDir, ver, 'bin/dsh');
        if (existsSync(binPath)) {
          return binPath;
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }
  return 'dsh';
}

function buildDshEnv(executablePath: string): NodeJS.ProcessEnv {
  const home = homedir();
  const extraPaths = [
    executablePath.includes('/') ? dirname(executablePath) : '',
    join(home, '.bun/bin'),
    join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const currentPath = process.env.PATH ?? '';
  return {
    ...process.env,
    PATH: [...extraPaths, currentPath].filter(Boolean).join(':'),
  };
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
