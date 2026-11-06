import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  createAgentInfo,
  createCanonicalEvent,
  DEFAULT_MAX_TOOL_OUTPUT_LENGTH,
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
  permissionRequests: true,
  modelSwitch: true,
  sessionResume: true,
  cancel: true,
} as const;

export type ClaudeCodeNormalizerOptions = {
  machineId?: string | undefined;
  maxToolOutputLength?: number | undefined;
  now?: (() => Date) | undefined;
  idGenerator?: (() => string) | undefined;
};

type RawRecord = Record<string, unknown>;

export class ClaudeCodeEventNormalizer {
  private readonly machineId: string | undefined;
  private readonly maxToolOutputLength: number;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  private readonly sequences = new Map<string, number>();
  private readonly claudeSessionIds = new Map<string, string>();
  private readonly sessionStatuses = new Map<string, AgentStatus>();

  constructor(options: ClaudeCodeNormalizerOptions = {}) {
    this.machineId = options.machineId;
    this.maxToolOutputLength = options.maxToolOutputLength ?? DEFAULT_MAX_TOOL_OUTPUT_LENGTH;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => `evt_${randomUUID()}`);
  }

  getClaudeSessionId(sessionId: string): string | undefined {
    return this.claudeSessionIds.get(sessionId);
  }

  getSessionStatus(sessionId: string): AgentStatus | undefined {
    return this.sessionStatuses.get(sessionId);
  }

  normalize(sessionId: string, rawInput: unknown): CanonicalAgentEvent[] {
    if (!isRecord(rawInput) || typeof rawInput.type !== 'string') {
      return [];
    }

    const remoteSessionId = asString(rawInput.session_id);
    if (remoteSessionId) {
      this.claudeSessionIds.set(sessionId, remoteSessionId);
    }

    switch (rawInput.type) {
      case 'system': {
        if (rawInput.subtype === 'init') {
          this.sessionStatuses.set(sessionId, 'running');
          return [
            this.buildEvent(sessionId, 'status', {
              status: 'running',
              detail: 'Claude Code session initialized',
            }),
          ];
        }
        return [];
      }

      case 'assistant': {
        const msg = isRecord(rawInput.message) ? rawInput.message : undefined;
        const content = Array.isArray(msg?.content) ? msg.content : [];
        const events: CanonicalAgentEvent[] = [];

        for (const block of content) {
          if (!isRecord(block) || typeof block.type !== 'string') continue;

          if (block.type === 'thinking') {
            const delta = asString(block.thinking) ?? asString(block.text) ?? '';
            if (delta) {
              events.push(this.buildEvent(sessionId, 'thinking_delta', { delta }));
            }
          } else if (block.type === 'text') {
            const delta = asString(block.text) ?? '';
            if (delta) {
              events.push(this.buildEvent(sessionId, 'text_delta', { delta }));
            }
          } else if (block.type === 'tool_use') {
            const toolCallId = asString(block.id) ?? `call_${randomUUID()}`;
            const name = asString(block.name) ?? 'tool';
            const input = isRecord(block.input) ? redactSensitiveData(block.input) : {};
            events.push(
              this.buildEvent(sessionId, 'tool_use', {
                toolCallId,
                name,
                input,
              }),
            );
          }
        }
        return events;
      }

      case 'user': {
        const msg = isRecord(rawInput.message) ? rawInput.message : undefined;
        const content = Array.isArray(msg?.content) ? msg.content : [];
        const events: CanonicalAgentEvent[] = [];

        for (const block of content) {
          if (!isRecord(block) || block.type !== 'tool_result') continue;
          const toolCallId = asString(block.tool_use_id) ?? '';
          if (!toolCallId) continue;
          const rawContent =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content ?? '');
          const { content: truncatedContent, truncated } = truncateOutput(
            rawContent,
            this.maxToolOutputLength,
          );
          const isError = Boolean(block.is_error);
          events.push(
            this.buildEvent(sessionId, 'tool_result', {
              toolCallId,
              content: truncatedContent,
              isError,
              ...(truncated ? { truncated: true } : {}),
            }),
          );
        }
        return events;
      }

      case 'result': {
        const events: CanonicalAgentEvent[] = [];
        const isError = Boolean(rawInput.is_error);
        const usage = isRecord(rawInput.usage) ? rawInput.usage : undefined;
        if (usage) {
          events.push(
            this.buildEvent(sessionId, 'usage', {
              inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
              outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
              costUsd: typeof rawInput.total_cost_usd === 'number' ? rawInput.total_cost_usd : 0,
            }),
          );
        }

        if (isError) {
          this.sessionStatuses.set(sessionId, 'failed');
          events.push(
            this.buildEvent(sessionId, 'error', {
              code: 'CLAUDE_EXECUTION_FAILED',
              message:
                asString(rawInput.error) ??
                asString(rawInput.result) ??
                'Claude Code execution failed',
              retryable: false,
            }),
          );
        } else {
          this.sessionStatuses.set(sessionId, 'idle');
          events.push(
            this.buildEvent(sessionId, 'status', {
              status: 'idle',
              detail: 'Claude Code turn completed',
            }),
          );
        }
        return events;
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
    const nextSeq = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, nextSeq);

    return createCanonicalEvent({
      eventId: this.idGenerator(),
      machineId: this.machineId,
      agentId: 'claude-code',
      sessionId,
      sequence: nextSeq,
      timestamp: this.now().toISOString(),
      type,
      payload,
    });
  }
}

export type ClaudeProcessHandle = {
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
};

export type ClaudeCodeAdapterOptions = ClaudeCodeNormalizerOptions & {
  executablePath?: string | undefined;
  defaultProjectPath?: string | undefined;
  detectVersion?: (() => Promise<string>) | undefined;
  spawnProcess?:
    | ((args: string[], options: { cwd?: string | undefined }) => ClaudeProcessHandle)
    | undefined;
};

type ClaudeSessionRecord = AgentSession & {
  claudeSessionId?: string | undefined;
};

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code' as const;
  readonly name = 'Claude Code';
  readonly capabilities = { ...capabilities };

  private readonly executablePath: string;
  private readonly defaultProjectPath: string;
  private readonly detectVersionImpl: () => Promise<string>;
  private readonly spawnProcessImpl: (
    args: string[],
    options: { cwd?: string | undefined },
  ) => ClaudeProcessHandle;
  private readonly normalizer: ClaudeCodeEventNormalizer;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sessions = new Map<string, ClaudeSessionRecord>();
  private readonly activeProcesses = new Map<string, ClaudeProcessHandle>();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.executablePath = resolveClaudeBinary(
      options.executablePath ?? process.env.NIENIE_CLAUDE_BIN,
    );
    this.defaultProjectPath = options.defaultProjectPath ?? process.cwd();
    this.normalizer = new ClaudeCodeEventNormalizer(options);

    this.detectVersionImpl =
      options.detectVersion ??
      (async () => {
        const { stdout } = await execFileAsync(this.executablePath, ['--version'], {
          timeout: 3000,
          env: buildClaudeEnv(this.executablePath),
        });
        return stdout.trim();
      });

    this.spawnProcessImpl =
      options.spawnProcess ??
      ((args, spawnOpts) => {
        const child = spawn(this.executablePath, args, {
          cwd: spawnOpts.cwd || this.defaultProjectPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildClaudeEnv(this.executablePath),
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
    const record: ClaudeSessionRecord = {
      id: `claude_ses_${randomUUID()}`,
      agentId: 'claude-code',
      title: input.title?.trim() || 'Claude Code Session',
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
    const record: ClaudeSessionRecord = {
      id: sessionId,
      claudeSessionId: sessionId,
      agentId: 'claude-code',
      title: `Claude Session ${sessionId.slice(0, 8)}`,
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

    const remoteId = record.claudeSessionId ?? this.normalizer.getClaudeSessionId(sessionId);
    const args = remoteId
      ? ['-p', '--output-format', 'stream-json', '--verbose', '--resume', remoteId, message]
      : ['-p', '--output-format', 'stream-json', '--verbose', message];

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

  private processLine(sessionId: string, record: ClaudeSessionRecord, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const events = this.normalizer.normalize(sessionId, parsed);
      const boundId = this.normalizer.getClaudeSessionId(sessionId);
      if (boundId) record.claudeSessionId = boundId;
      for (const evt of events) {
        for (const listener of this.listeners) listener(evt);
      }
    } catch {
      // Ignore non-JSON lines
    }
  }
}

export {
  DshAdapter,
  DshEventNormalizer,
  type DshAdapterOptions,
  type DshNormalizerOptions,
  type DshProcessHandle,
} from './dsh.js';

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveClaudeBinary(explicit?: string): string {
  if (explicit) return explicit;
  const home = homedir();
  const directCandidates = [
    join(home, '.bun/bin/claude'),
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const nvmDir = join(home, '.nvm/versions/node');
  if (existsSync(nvmDir)) {
    try {
      const versions = readdirSync(nvmDir).sort().reverse();
      for (const ver of versions) {
        const binPath = join(nvmDir, ver, 'bin/claude');
        if (existsSync(binPath)) {
          return binPath;
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }
  return 'claude';
}

function buildClaudeEnv(executablePath: string): NodeJS.ProcessEnv {
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
