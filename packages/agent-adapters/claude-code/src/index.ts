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
  /** 事件流实例标识；缺省时生成，历史回放与实时事件共享同一 epoch。 */
  streamEpoch?: string | undefined;
};

type RawRecord = Record<string, unknown>;

export class ClaudeCodeEventNormalizer {
  private readonly machineId: string | undefined;
  readonly streamEpoch: string;
  private readonly maxToolOutputLength: number;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  private readonly sequences = new Map<string, number>();
  private readonly claudeSessionIds = new Map<string, string>();
  private readonly sessionStatuses = new Map<string, AgentStatus>();

  constructor(options: ClaudeCodeNormalizerOptions = {}) {
    this.machineId = options.machineId;
    this.streamEpoch = options.streamEpoch ?? generateStreamEpoch();
    this.maxToolOutputLength = options.maxToolOutputLength ?? DEFAULT_MAX_TOOL_OUTPUT_LENGTH;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => `evt_${randomUUID()}`);
  }

  /** 分配某会话的下一个 sequence（历史回放与实时事件共享同一单调序列）。 */
  nextSequence(sessionId: string): number {
    const nextSeq = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, nextSeq);
    return nextSeq;
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
    const nextSeq = this.nextSequence(sessionId);

    return createCanonicalEvent({
      eventId: this.idGenerator(),
      streamEpoch: this.streamEpoch,
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
  /** R3-4：确认进程真正启动成功（Node 'spawn' 事件）。spawn 是异步确认，error 事件才暴露启动失败。 */
  onSpawn(listener: () => void): void;
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
  private readonly discoverLocalHistory: boolean;
  private historyLoaded = false;
  /** sessionId → 历史 jsonl 文件路径（发现时记录，供回放）。 */
  private readonly historyFileBySession = new Map<string, string>();
  /** 已回放的 jsonl 行 uuid，保证幂等。 */
  private readonly emittedHistoryUuids = new Set<string>();
  /** 已回放历史的会话（避免重复扫描）。 */
  private readonly loadedHistorySessions = new Set<string>();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.executablePath = resolveClaudeBinary(
      options.executablePath ?? process.env.NIENIE_CLAUDE_BIN,
    );
    this.defaultProjectPath = options.defaultProjectPath ?? process.cwd();
    this.normalizer = new ClaudeCodeEventNormalizer(options);
    this.discoverLocalHistory = !options.spawnProcess && !options.detectVersion;

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
    if (this.discoverLocalHistory && !this.historyLoaded) {
      this.historyLoaded = true;
      this.loadLocalClaudeHistory();
    }
    return [...this.sessions.values()];
  }

  private loadLocalClaudeHistory(): void {
    const projectsDir = join(homedir(), '.claude/projects');
    if (!existsSync(projectsDir)) return;
    try {
      for (const projEntry of readdirSync(projectsDir)) {
        if (projEntry.startsWith('.')) continue;
        const projPath = join(projectsDir, projEntry);
        const decodedCwd = projEntry.startsWith('-')
          ? projEntry.replaceAll('-', '/')
          : this.defaultProjectPath;
        let files: string[] = [];
        try {
          files = readdirSync(projPath).filter((f) => f.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const file of files) {
          const sessionId = file.replace(/\.jsonl$/, '');
          if (this.sessions.has(sessionId)) continue;
          let resolvedCwd = decodedCwd;
          let resolvedTitle = `Claude (${projEntry.split('-').pop() || 'Session'})`;
          try {
            const firstChunk = readFileSync(join(projPath, file), 'utf8').slice(0, 4096);
            for (const line of firstChunk.split('\n')) {
              if (!line.trim()) continue;
              const obj = JSON.parse(line) as { cwd?: string; message?: { content?: unknown } };
              if (typeof obj.cwd === 'string' && obj.cwd.trim()) {
                resolvedCwd = obj.cwd.trim();
              }
              if (typeof obj.message?.content === 'string' && obj.message.content.trim()) {
                resolvedTitle = obj.message.content.trim().slice(0, 48);
                break;
              }
            }
          } catch {
            // Ignore file read errors
          }
          if (
            resolvedCwd.includes('/.claude/worktrees/') ||
            !existsSync(resolvedCwd)
          ) {
            continue;
          }
          const nowIso = new Date().toISOString();
          this.historyFileBySession.set(sessionId, join(projPath, file));
          this.sessions.set(sessionId, {
            id: sessionId,
            claudeSessionId: sessionId,
            agentId: 'claude-code',
            title: resolvedTitle,
            projectPath: resolvedCwd,
            status: 'idle',
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        }
      }
    } catch {
      // Ignore directory scan errors
    }
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
    // 首次加载：回放本地历史（幂等，按行 uuid 去重）
    if (this.discoverLocalHistory && !this.loadedHistorySessions.has(sessionId)) {
      this.loadedHistorySessions.add(sessionId);
      this.emitClaudeSessionHistory(sessionId);
    }

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

  /** 从 ~/.claude/projects 下的 <sessionId>.jsonl 回放历史，稳定 eventId 供幂等去重。 */
  private emitClaudeSessionHistory(sessionId: string): void {
    const file = this.historyFileBySession.get(sessionId);
    if (!file || !existsSync(file)) return;
    try {
      const content = readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let obj: {
          uuid?: string;
          timestamp?: string;
          type?: string;
          message?: {
            content?: unknown;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
        };
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const uuid = obj.uuid ?? '';
        if (uuid && this.emittedHistoryUuids.has(uuid)) continue;
        if (uuid) this.emittedHistoryUuids.add(uuid);
        const ts = obj.timestamp ?? new Date().toISOString();
        const msg = obj.message;
        if (!msg) continue;

        if (obj.type === 'user') {
          const blocks =
            typeof msg.content === 'string'
              ? [{ type: 'text', text: msg.content }]
              : Array.isArray(msg.content)
                ? (msg.content as Array<Record<string, unknown>>)
                : [];
          let idx = 0;
          for (const b of blocks) {
            if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              this.emitHistoryEvent(sessionId, `${uuid}:${idx++}`, ts, 'text_delta', {
                delta: b.text.trim(),
                role: 'user',
              });
            } else if (b?.type === 'tool_result') {
              this.emitHistoryEvent(sessionId, `${uuid}:result${idx++}`, ts, 'tool_result', {
                toolCallId: (b.tool_use_id as string) ?? '',
                content: formatHistoryContent(b.content),
                isError: b.is_error === true,
              });
            }
          }
        } else if (obj.type === 'assistant' && Array.isArray(msg.content)) {
          let idx = 0;
          for (const b of msg.content as Array<Record<string, unknown>>) {
            if (b?.type === 'thinking' && typeof b.thinking === 'string') {
              this.emitHistoryEvent(sessionId, `${uuid}:think${idx++}`, ts, 'thinking_delta', {
                delta: b.thinking,
              });
            } else if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
              this.emitHistoryEvent(sessionId, `${uuid}:text${idx++}`, ts, 'text_delta', {
                delta: b.text,
              });
            } else if (b?.type === 'tool_use') {
              this.emitHistoryEvent(sessionId, `${uuid}:tool${idx++}`, ts, 'tool_use', {
                toolCallId: (b.id as string) ?? `call_${uuid}_${idx}`,
                name: (b.name as string) ?? 'tool',
                input: isRecord(b.input) ? redactSensitiveData(b.input) : {},
              });
            }
          }
        }
      }
    } catch {
      // Ignore history read errors
    }
  }

  private emitHistoryEvent(
    sessionId: string,
    suffix: string,
    timestamp: string,
    type: CanonicalAgentEventType,
    payload: Record<string, unknown>,
  ): void {
    const event = createCanonicalEvent({
      eventId: `history:${sessionId}:${suffix}`,
      streamEpoch: this.normalizer.streamEpoch,
      agentId: 'claude-code',
      sessionId,
      sequence: this.normalizer.nextSequence(sessionId),
      timestamp,
      type,
      payload,
    });
    for (const listener of this.listeners) listener(event);
  }

  /** 各运行的后台执行 Promise（R3-4 统一送达语义：sendMessage=接受即返回，执行用 waitForRun 等待）。 */
  private readonly runs = new Map<string, Promise<void>>();

  async sendMessage(sessionId: string, message: string): Promise<void> {
    // F5：同一 session 同一时刻只允许一个活动进程（单轮执行模型）——并发第二条拒绝
    if (this.activeProcesses.has(sessionId)) {
      throw new Error('会话已有运行中的任务，请等待完成或取消后再发送');
    }
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
      this.emitRunError(
        sessionId,
        `Claude Code 启动失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    // 执行在后台继续；完成/失败经事件流上报，sendMessage 不等待整个 Agent 执行
    const run = new Promise<void>((resolve, reject) => {
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
        this.emitRunError(
          sessionId,
          `Claude Code 运行失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        reject(err);
      });
      proc.onExit((code) => {
        const cancelled = !this.activeProcesses.has(sessionId);
        if (buffer.trim()) {
          this.processLine(sessionId, record!, buffer);
        }
        this.activeProcesses.delete(sessionId);
        // R3-4/F3：非零退出码或信号终止（code=null）按失败处理并上报（取消路径不覆盖）
        if (!cancelled && (code === null || code !== 0)) {
          this.emitRunError(
            sessionId,
            code === null ? 'Claude Code 进程被信号终止' : `Claude Code 异常退出（退出码 ${code}）`,
          );
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
      agentId: 'claude-code' as const,
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
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      // R3-4：先摘除再 kill，onExit 依据 activeProcesses 判定取消，不误报非零退出失败
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

function formatHistoryContent(value: unknown): string {
  const raw =
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : Array.isArray(value)
          ? value
              .map((v) => (typeof v === 'string' ? v : isRecord(v) ? (v.text ?? '') : ''))
              .join('')
          : (() => {
              try {
                return JSON.stringify(value);
              } catch {
                return String(value);
              }
            })();
  return truncateOutput(raw, DEFAULT_MAX_TOOL_OUTPUT_LENGTH).content;
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
