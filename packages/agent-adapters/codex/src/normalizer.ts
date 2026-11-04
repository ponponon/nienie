import { randomUUID } from 'node:crypto';
import {
  createCanonicalEvent,
  DEFAULT_MAX_TOOL_OUTPUT_LENGTH,
  redactSensitiveData,
  truncateOutput,
} from '@nienie/agent-events';
import type { AgentStatus, CanonicalAgentEvent, CanonicalAgentEventType } from '@nienie/protocol';

export type CodexNormalizerOptions = {
  machineId?: string | undefined;
  maxToolOutputLength?: number | undefined;
  now?: (() => Date) | undefined;
  idGenerator?: (() => string) | undefined;
};

type RawRecord = Record<string, unknown>;

export class CodexEventNormalizer {
  private readonly machineId: string | undefined;
  private readonly maxToolOutputLength: number;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  private readonly sequences = new Map<string, number>();
  private readonly itemTextLengths = new Map<string, number>();
  private readonly emittedToolUses = new Set<string>();
  private readonly emittedToolResults = new Set<string>();
  private readonly threadIds = new Map<string, string>();
  private readonly sessionStatuses = new Map<string, AgentStatus>();

  constructor(options: CodexNormalizerOptions = {}) {
    this.machineId = options.machineId;
    this.maxToolOutputLength = options.maxToolOutputLength ?? DEFAULT_MAX_TOOL_OUTPUT_LENGTH;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => `evt_${randomUUID()}`);
  }

  getThreadId(sessionId: string): string | undefined {
    return this.threadIds.get(sessionId);
  }

  getSessionStatus(sessionId: string): AgentStatus | undefined {
    return this.sessionStatuses.get(sessionId);
  }

  normalize(sessionId: string, rawInput: unknown): CanonicalAgentEvent[] {
    if (!isRecord(rawInput) || typeof rawInput.type !== 'string') {
      return [];
    }

    const type = rawInput.type.toLowerCase();

    switch (type) {
      case 'thread.started': {
        const threadId = asString(rawInput.thread_id) ?? asString(rawInput.threadId);
        if (threadId) {
          this.threadIds.set(sessionId, threadId);
        }
        return [];
      }

      case 'turn.started': {
        this.sessionStatuses.set(sessionId, 'running');
        return [
          this.buildEvent(sessionId, 'status', {
            status: 'running',
            detail: 'Codex turn started',
          }),
        ];
      }

      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = isRecord(rawInput.item) ? rawInput.item : undefined;
        if (!item) return [];
        return this.handleItemEvent(sessionId, type, item);
      }

      case 'turn.completed': {
        const events: CanonicalAgentEvent[] = [];
        const usage = isRecord(rawInput.usage) ? rawInput.usage : undefined;
        if (usage) {
          const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
          const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
          const cachedInputTokens =
            typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : undefined;
          const costUsd = typeof usage.cost_usd === 'number' ? usage.cost_usd : 0;

          events.push(
            this.buildEvent(sessionId, 'usage', {
              inputTokens,
              outputTokens,
              ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
              costUsd,
            }),
          );
        }
        this.sessionStatuses.set(sessionId, 'idle');
        events.push(
          this.buildEvent(sessionId, 'status', {
            status: 'idle',
            detail: 'Codex turn completed',
          }),
        );
        return events;
      }

      case 'turn.failed':
      case 'error': {
        this.sessionStatuses.set(sessionId, 'failed');
        const errObj = isRecord(rawInput.error) ? rawInput.error : undefined;
        const message =
          asString(errObj?.message) ??
          asString(rawInput.message) ??
          'Codex execution failed';
        const code = asString(errObj?.code) ?? 'CODEX_EXECUTION_FAILED';
        const retryable = Boolean(errObj?.retryable ?? rawInput.retryable ?? false);
        return [
          this.buildEvent(sessionId, 'error', {
            code,
            message,
            retryable,
          }),
        ];
      }

      default:
        return [];
    }
  }

  private handleItemEvent(
    sessionId: string,
    phase: string,
    item: RawRecord,
  ): CanonicalAgentEvent[] {
    const itemId = asString(item.id) ?? `item_${randomUUID()}`;
    const itemType = asString(item.type);
    if (!itemType) return [];

    if (itemType === 'reasoning' || itemType === 'agent_message') {
      const fullText = asString(item.text) ?? '';
      const key = `${sessionId}:${itemId}`;
      const prevLen = this.itemTextLengths.get(key) ?? 0;
      if (fullText.length <= prevLen) return [];

      const delta = fullText.slice(prevLen);
      this.itemTextLengths.set(key, fullText.length);
      const eventType: CanonicalAgentEventType =
        itemType === 'reasoning' ? 'thinking_delta' : 'text_delta';
      return [this.buildEvent(sessionId, eventType, { delta })];
    }

    if (itemType === 'command_execution') {
      const command = asString(item.command) ?? '';
      const input = redactSensitiveData({ command });
      const events = this.emitToolUseIfNeeded(sessionId, itemId, 'bash', input);

      if (phase === 'item.completed') {
        const output =
          asString(item.aggregated_output) ??
          asString(item.output) ??
          '';
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : 0;
        const status = asString(item.status);
        const isError = exitCode !== 0 || status === 'failed';
        events.push(...this.emitToolResult(sessionId, itemId, output, isError));
      }
      return events;
    }

    if (itemType === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const input = redactSensitiveData({ changes });
      const events = this.emitToolUseIfNeeded(sessionId, itemId, 'file_change', input);

      if (phase === 'item.completed') {
        const summary = changes
          .map((change) => {
            if (!isRecord(change)) return '';
            const kind = asString(change.kind) ?? 'modify';
            const filePath = asString(change.path) ?? '';
            return `${kind} ${filePath}`.trim();
          })
          .filter(Boolean)
          .join(', ');
        const isError = asString(item.status) === 'failed';
        events.push(
          ...this.emitToolResult(sessionId, itemId, summary || 'Files updated', isError),
        );
      }
      return events;
    }

    if (itemType === 'mcp_tool_call') {
      const toolName = asString(item.tool) ?? 'mcp_tool';
      const args = isRecord(item.arguments) ? redactSensitiveData(item.arguments) : {};
      const events = this.emitToolUseIfNeeded(sessionId, itemId, toolName, args);

      if (phase === 'item.completed') {
        const hasError = item.error !== undefined && item.error !== null;
        const content = hasError
          ? formatContent(item.error)
          : formatContent(item.result ?? '');
        events.push(...this.emitToolResult(sessionId, itemId, content, hasError));
      }
      return events;
    }

    return [];
  }

  private emitToolUseIfNeeded(
    sessionId: string,
    toolCallId: string,
    name: string,
    input: Record<string, unknown>,
  ): CanonicalAgentEvent[] {
    const key = `${sessionId}:${toolCallId}`;
    if (this.emittedToolUses.has(key)) return [];
    this.emittedToolUses.add(key);

    return [
      this.buildEvent(sessionId, 'tool_use', {
        toolCallId,
        name,
        input,
      }),
    ];
  }

  private emitToolResult(
    sessionId: string,
    toolCallId: string,
    rawContent: string,
    isError: boolean,
  ): CanonicalAgentEvent[] {
    const key = `${sessionId}:${toolCallId}`;
    if (this.emittedToolResults.has(key)) return [];
    this.emittedToolResults.add(key);

    const { content, truncated } = truncateOutput(rawContent, this.maxToolOutputLength);
    return [
      this.buildEvent(sessionId, 'tool_result', {
        toolCallId,
        content,
        isError,
        ...(truncated ? { truncated: true } : {}),
      }),
    ];
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
      agentId: 'codex',
      sessionId,
      sequence: nextSeq,
      timestamp: this.now().toISOString(),
      type,
      payload,
    });
  }
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function formatContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
