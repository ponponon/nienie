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

  /** R3-4：会话单调序号（供 Adapter 直接构造的事件复用同一序号空间，避免重复 sequence 被客户端误判重）。 */
  nextSequence(sessionId: string): number {
    const nextSeq = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, nextSeq);
    return nextSeq;
  }

  private buildEvent(
    sessionId: string,
    type: CanonicalAgentEventType,
    payload: Record<string, unknown>,
  ): CanonicalAgentEvent {
    const nextSeq = this.nextSequence(sessionId);

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
  /** R3-4：确认进程真正启动成功（Node 'spawn' 事件）。spawn 是异步确认，error 事件才暴露启动失败。 */
  onSpawn(listener: () => void): void;
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
  /** F5：await 前同步启动占位——loadSession 等 await 窗口内阻止并发双 spawn。 */
  private readonly startingSessions = new Set<string>();

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
          onSpawn(listener) {
            child.once('spawn', () => listener());
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

  /** 各运行的后台执行 Promise（R3-4 统一送达语义：sendMessage=接受即返回，执行用 waitForRun 等待）。 */
  private readonly runs = new Map<string, Promise<void>>();

  async sendMessage(sessionId: string, message: string): Promise<void> {
    // F5：同一 session 同一时刻只允许一个活动进程（单轮执行模型）——
    // 检查+占位必须在任何 await 之前同步完成（否则 loadSession 的 await 窗口双 spawn）
    if (this.activeProcesses.has(sessionId) || this.startingSessions.has(sessionId)) {
      throw new Error('会话已有运行中的任务，请等待完成或取消后再发送');
    }
    this.startingSessions.add(sessionId);
    let session: AgentSession;
    let proc: PiProcessHandle;
    try {
      session = this.sessions.get(sessionId)!;
      if (!session) {
        session = await this.loadSession(sessionId);
      }

      const args = ['--mode', 'json', '--session', sessionId, '-p', message];
      proc = this.spawnProcessImpl(args, { cwd: session.projectPath });
      this.activeProcesses.set(sessionId, proc); // 占位转入活动进程
    } finally {
      this.startingSessions.delete(sessionId); // 成功转入 active / 中途失败均释放占位
    }

    // R3-4：真正确认 spawn 成功才「已送达电脑」（spawn 是异步确认，失败必须拒绝而非假送达）
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        proc.onSpawn(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        proc.onError((error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      });
    } catch (error) {
      this.activeProcesses.delete(sessionId);
      session.status = 'failed'; // F3：失败终态持久化到 Session Record
      session.updatedAt = new Date().toISOString();
      this.emitRunError(
        sessionId,
        `Pi 启动失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    session.status = 'running'; // F3：启动成功即持久化运行态
    session.updatedAt = new Date().toISOString();

    // 执行在后台继续；完成/失败经事件流上报，sendMessage 不等待整个 Agent 执行
    const run = new Promise<void>((resolve, reject) => {
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
        this.emitRunError(
          sessionId,
          `Pi 运行失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        reject(err);
      });
      proc.onExit((code) => {
        const cancelled = !this.activeProcesses.has(sessionId);
        if (buffer.trim()) {
          this.processLine(sessionId, buffer);
        }
        this.activeProcesses.delete(sessionId);
        // R3-4/F3：非零退出码或信号终止（code=null）按失败处理并上报（取消路径不覆盖）
        const sessionRecord = this.sessions.get(sessionId);
        if (!cancelled && (code === null || code !== 0)) {
          if (sessionRecord) {
            sessionRecord.status = 'failed'; // F3：终态持久化（listSessions 不再回旧 idle）
            sessionRecord.updatedAt = new Date().toISOString();
          }
          this.emitRunError(
            sessionId,
            code === null ? 'Pi 进程被信号终止' : `Pi 异常退出（退出码 ${code}）`,
          );
        } else if (!cancelled && sessionRecord) {
          sessionRecord.status = 'idle'; // F3：完成态持久化
          sessionRecord.updatedAt = new Date().toISOString();
        }
        resolve();
      });
    });
    this.runs.set(sessionId, run);
    void run.catch(() => undefined); // 错误已由 emitRunError 事件上报
  }

  /// 等待某会话当前运行完成（测试与诊断用；sendMessage 本身不等待执行）
  async waitForRun(sessionId: string): Promise<void> {
    await this.runs.get(sessionId);
  }

  /** R3-4/F3：运行失败必须反馈到手机——错误事件 + 终态 status 事件（终止 Thinking 计时/置失败）。 */
  private emitRunError(sessionId: string, message: string): void {
    const base = {
      streamEpoch: this.normalizer.streamEpoch,
      agentId: 'pi' as const,
      sessionId,
      timestamp: new Date().toISOString(),
    };
    for (const event of [
      createCanonicalEvent({
        ...base,
        eventId: `runerr:${sessionId}:${Date.now()}`,
        sequence: this.normalizer.nextSequence(sessionId),
        type: 'error',
        payload: { code: 'RUN_FAILED', message, retryable: true },
      }),
      createCanonicalEvent({
        ...base,
        eventId: `runst:${sessionId}:${Date.now()}`,
        sequence: this.normalizer.nextSequence(sessionId),
        type: 'status',
        payload: { status: 'failed', detail: message },
      }),
    ]) {
      for (const listener of this.listeners) listener(event);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    // F3：先标记 cancelled 再 kill（onExit 依据 activeProcesses 判定取消，不误报失败）
    this.startingSessions.delete(sessionId); // F5：启动中的占位一并释放
    const record = this.sessions.get(sessionId);
    if (record && record.status === 'running') {
      record.status = 'cancelled';
      record.updatedAt = new Date().toISOString();
    }
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      this.activeProcesses.delete(sessionId);
      proc.kill();
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
