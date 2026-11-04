import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createAgentInfo, type AgentAdapter } from '@nienie/agent-events';
import type {
  AgentSession,
  CanonicalAgentEvent,
  CreateSessionInput,
} from '@nienie/protocol';
import { CodexEventNormalizer, type CodexNormalizerOptions } from './normalizer.js';

export { CodexEventNormalizer, type CodexNormalizerOptions } from './normalizer.js';

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

export type CodexProcessHandle = {
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
};

export type CodexSpawnOptions = {
  cwd?: string | undefined;
};

export type CodexAdapterOptions = CodexNormalizerOptions & {
  executablePath?: string | undefined;
  defaultProjectPath?: string | undefined;
  detectVersion?: (() => Promise<string>) | undefined;
  spawnProcess?: ((args: string[], options: CodexSpawnOptions) => CodexProcessHandle) | undefined;
};

type CodexSessionRecord = AgentSession & {
  threadId?: string | undefined;
};

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly name = 'Codex';
  readonly capabilities = { ...capabilities };

  private readonly executablePath: string;
  private readonly defaultProjectPath: string;
  private readonly detectVersionImpl: () => Promise<string>;
  private readonly spawnProcessImpl: (
    args: string[],
    options: CodexSpawnOptions,
  ) => CodexProcessHandle;
  private readonly normalizer: CodexEventNormalizer;
  private readonly listeners = new Set<(event: CanonicalAgentEvent) => void>();
  private readonly sessions = new Map<string, CodexSessionRecord>();
  private readonly activeProcesses = new Map<string, CodexProcessHandle>();

  constructor(options: CodexAdapterOptions = {}) {
    this.executablePath = options.executablePath ?? process.env.NIENIE_CODEX_BIN ?? 'codex';
    this.defaultProjectPath = options.defaultProjectPath ?? process.cwd();
    this.normalizer = new CodexEventNormalizer(options);

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
      const rawVersion = await this.detectVersionImpl();
      if (!rawVersion) {
        return createAgentInfo(this, false);
      }
      const match = rawVersion.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      const version = match?.[1] ?? rawVersion.trim();
      return createAgentInfo(this, true, version);
    } catch {
      return createAgentInfo(this, false);
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    return [...this.sessions.values()].map((record) => this.toAgentSession(record));
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const nowIso = new Date().toISOString();
    const record: CodexSessionRecord = {
      id: `codex_ses_${randomUUID()}`,
      agentId: 'codex',
      title: input.title?.trim() || 'Codex Session',
      projectPath: input.projectPath?.trim() || this.defaultProjectPath,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(record.id, record);
    return this.toAgentSession(record);
  }

  async loadSession(sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return this.toAgentSession(existing);
    }

    const nowIso = new Date().toISOString();
    const resumed: CodexSessionRecord = {
      id: sessionId,
      threadId: sessionId,
      agentId: 'codex',
      title: `Codex Thread ${sessionId.slice(0, 8)}`,
      projectPath: this.defaultProjectPath,
      status: 'idle',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.sessions.set(sessionId, resumed);
    return this.toAgentSession(resumed);
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    let record = this.sessions.get(sessionId);
    if (!record) {
      await this.loadSession(sessionId);
      record = this.sessions.get(sessionId)!;
    }

    const boundThreadId = record.threadId ?? this.normalizer.getThreadId(sessionId);
    const args: string[] = boundThreadId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', boundThreadId, message]
      : ['exec', '--json', '--skip-git-repo-check', '-C', record.projectPath, message];

    const proc = this.spawnProcessImpl(args, { cwd: record.projectPath });
    this.activeProcesses.set(sessionId, proc);
    record.status = 'running';
    record.updatedAt = new Date().toISOString();

    await new Promise<void>((resolve, reject) => {
      let buffer = '';

      proc.stdout.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          this.processJsonLine(sessionId, record!, line);
        }
      });

      proc.onError((error) => {
        this.activeProcesses.delete(sessionId);
        record!.status = 'failed';
        reject(error);
      });

      proc.onExit(() => {
        if (buffer.trim().length > 0) {
          this.processJsonLine(sessionId, record!, buffer);
          buffer = '';
        }
        this.activeProcesses.delete(sessionId);
        const normStatus = this.normalizer.getSessionStatus(sessionId);
        if (normStatus) {
          record!.status = normStatus;
        } else if (record!.status === 'running') {
          record!.status = 'idle';
        }
        record!.updatedAt = new Date().toISOString();
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
    const record = this.sessions.get(sessionId);
    if (record) {
      record.status = 'cancelled';
      record.updatedAt = new Date().toISOString();
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

  private processJsonLine(
    sessionId: string,
    record: CodexSessionRecord,
    line: string,
  ): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    const events = this.normalizer.normalize(sessionId, parsed);
    const threadId = this.normalizer.getThreadId(sessionId);
    if (threadId) {
      record.threadId = threadId;
    }

    for (const event of events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  private toAgentSession(record: CodexSessionRecord): AgentSession {
    const status = this.normalizer.getSessionStatus(record.id) ?? record.status;
    return {
      id: record.id,
      agentId: 'codex',
      title: record.title,
      projectPath: record.projectPath,
      status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
