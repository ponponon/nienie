import type {
  AgentId,
  CanonicalAgentEvent,
  SessionSnapshot,
  SessionSnapshotPart,
} from '@nienie/protocol';

/**
 * Session 串行执行器：同一 Session 的「实时事件应用」与「快照捕获」在同一临界区执行，
 * 保证 Snapshot 与实时事件共用一条确定的 watermark 边界（一致性屏障）。
 */
export interface SessionSerialExecutor {
  run<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T>;
}

/** 默认实现：按 sessionId 串行化（同 Session 顺序执行，不同 Session 并发）。 */
export function createSessionSerialExecutor(): SessionSerialExecutor {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
      const prev = tails.get(sessionId) ?? Promise.resolve();
      const next = prev.then(operation, operation);
      tails.set(
        sessionId,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },
  };
}

/**
 * Session 状态存储：维护 Part 状态 + 最后应用 sequence（watermark）。
 * Snapshot 由此生成（状态，非事件），实时事件经 applyEvent 更新。
 */
export interface SessionStateStore {
  applyEvent(event: CanonicalAgentEvent): void;
  getLastAppliedSequence(sessionId: string): number;
  createSnapshot(sessionId: string): SessionSnapshot;
}

export interface SessionStateStoreOptions {
  agentId: AgentId;
  streamEpoch: string;
  now?: (() => Date) | undefined;
  snapshotIdGenerator?: (() => string) | undefined;
}

type MutablePart = SessionSnapshotPart & { _seq: number };

/**
 * 内存版 Part 状态存储。Adapter 可在 loadSession 时用 hydrate() 灌入历史，
 * 之后实时事件经 applyEvent 增量更新；createSnapshot 同步深拷贝当前状态。
 */
export class InMemorySessionStateStore implements SessionStateStore {
  private readonly agentId: AgentId;
  private readonly streamEpoch: string;
  private readonly now: () => Date;
  private readonly snapshotIdGenerator: () => string;
  /** sessionId → partId → part（含排序/版本）。 */
  private readonly parts = new Map<string, Map<string, MutablePart>>();
  /** sessionId → 最后应用的 sequence（watermark）。 */
  private readonly lastSeq = new Map<string, number>();
  private seqCounter = 0;

  constructor(options: SessionStateStoreOptions) {
    this.agentId = options.agentId;
    this.streamEpoch = options.streamEpoch;
    this.now = options.now ?? (() => new Date());
    this.snapshotIdGenerator = options.snapshotIdGenerator ?? (() => `snap_${++this.seqCounter}`);
  }

  /** 从持久化历史灌入初始 Part 状态（不生成事件）。 */
  hydrate(sessionId: string, parts: SessionSnapshotPart[]): void {
    const map = this.parts.get(sessionId) ?? new Map<string, MutablePart>();
    for (const part of parts) {
      map.set(part.partId, { ...part, _seq: part.ordinal });
    }
    this.parts.set(sessionId, map);
    if (!this.lastSeq.has(sessionId)) this.lastSeq.set(sessionId, 0);
  }

  applyEvent(event: CanonicalAgentEvent): void {
    const sid = event.sessionId;
    const map = this.parts.get(sid) ?? new Map<string, MutablePart>();
    this.parts.set(sid, map);
    // 简化的 Part 状态推导：text_delta 更新/创建 message part，tool_* 更新 tool_call part。
    const p = event.payload as Record<string, unknown>;
    // Round 3：工具事件按稳定 toolCallId 归并（Codex 实时事件不带 partId，
    // tool_use/tool_result 必须落同一 Part，否则生成两个碎片 Part）
    const isToolEvent = event.type === 'tool_use' || event.type === 'tool_result';
    const partId =
      isToolEvent && typeof p.toolCallId === 'string'
        ? `tool:${p.toolCallId}`
        : ((p.partId as string) ?? `${event.type}:${event.sequence}`);
    const existing = map.get(partId);
    const revision = (p.revision as number) ?? ((existing?.revision ?? 0) + 1);
    const ts = event.timestamp;
    if (event.type === 'text_delta') {
      const prev = existing?.kind === 'message' ? existing : undefined;
      const text = (prev?.content?.[0]?.type === 'text' ? prev.content[0].text : '') + (p.delta as string ?? '');
      map.set(partId, {
        kind: 'message',
        partId,
        ordinal: existing?.ordinal ?? map.size,
        revision,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
        role: (p.role as 'user' | 'assistant') ?? 'assistant',
        content: [{ type: 'text', text }],
        _seq: event.sequence,
      });
    } else if (event.type === 'tool_use') {
      map.set(partId, {
        kind: 'tool_call',
        partId,
        ordinal: existing?.ordinal ?? map.size,
        revision,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
        toolCallId: (p.toolCallId as string) ?? partId,
        name: (p.name as string) ?? 'tool',
        input: (p.input as Record<string, unknown>) ?? {},
        status: 'running',
        // Round 3：tool_use=进入执行 → 真实开始时间（Round 4：timingKnown=false 历史回放不伪造）
        ...(p.timingKnown === false
          ? {}
          : existing?.kind === 'tool_call' && existing.toolStartedAt
            ? {}
            : { toolStartedAt: ts }),
        _seq: event.sequence,
      });
    } else if (event.type === 'tool_result') {
      const prev = existing?.kind === 'tool_call' ? existing : undefined;
      map.set(partId, {
        kind: 'tool_call',
        partId,
        ordinal: existing?.ordinal ?? map.size,
        revision,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
        toolCallId: (p.toolCallId as string) ?? partId,
        name: prev?.name ?? 'tool',
        input: prev?.input ?? {},
        status: p.isError ? 'failed' : 'completed',
        output: (p.content as string) ?? '',
        isError: (p.isError as boolean) ?? false,
        // Round 2：exitCode 事件→Snapshot 投影不丢失（缺失不伪造）
        ...(typeof p.exitCode === 'number' ? { exitCode: p.exitCode } : {}),
        // Round 3：tool_result=完成 → 真实完成时间；开始时间沿用 tool_use 侧
        ...(prev?.kind === 'tool_call' && prev.toolStartedAt
          ? { toolStartedAt: prev.toolStartedAt }
          : {}),
        ...(p.timingKnown === false ? {} : { toolFinishedAt: ts }),
        _seq: event.sequence,
      });
    }
    this.lastSeq.set(sid, event.sequence);
  }

  getLastAppliedSequence(sessionId: string): number {
    return this.lastSeq.get(sessionId) ?? 0;
  }

  createSnapshot(sessionId: string): SessionSnapshot {
    const map = this.parts.get(sessionId) ?? new Map<string, MutablePart>();
    const parts = [...map.values()]
      .sort((a, b) => a.ordinal - b.ordinal || a._seq - b._seq)
      .map(({ _seq, ...part }) => part);
    return {
      schemaVersion: 1,
      snapshotId: this.snapshotIdGenerator(),
      sessionId,
      agentId: this.agentId,
      streamEpoch: this.streamEpoch,
      watermark: this.getLastAppliedSequence(sessionId),
      capturedAt: this.now().toISOString(),
      complete: true,
      hasMore: false,
      totalParts: parts.length,
      parts,
    };
  }
}
