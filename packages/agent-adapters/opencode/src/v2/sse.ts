import { openCodeServiceAuthHeader } from '../service-discovery.js';
import { contentToText, extractToolOutput } from './message-restore.js';

export type V2EventFrame = {
  id?: string;
  created?: number;
  type: string;
  data: Record<string, unknown>;
};

export type LiveEventSpec = {
  type: 'status' | 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'usage' | 'error';
  payload: Record<string, unknown>;
};

/** 一帧多事件时以 type+序号派生稳定子 ID，保证重放稳定且多事件不被手机端 eventId 去重互吞。 */
export function v2LiveEventId(frameId: string, type: string, index: number): string {
  return `v2:${frameId}:${type}:${index}`;
}

export type V2StreamEndpoint = {
  baseUrl: string;
  password?: string | undefined;
};

export async function* streamV2EventFrames(options: {
  endpoint: V2StreamEndpoint;
  fetch?: typeof globalThis.fetch | undefined;
  signal: AbortSignal;
  parse: (stream: ReadableStream<Uint8Array>) => AsyncGenerator<unknown, void, undefined>;
}): AsyncGenerator<V2EventFrame, void, undefined> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  const auth = openCodeServiceAuthHeader(options.endpoint.password);
  if (auth) Object.assign(headers, auth);
  const response = await doFetch(new URL('/api/event', `${options.endpoint.baseUrl}/`), {
    headers,
    redirect: 'error',
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to connect to OpenCode v2 event stream (${response.status})`);
  }
  for await (const payload of options.parse(response.body)) {
    const frame = payload as V2EventFrame;
    if (frame && typeof frame.type === 'string' && typeof frame.data === 'object' && frame.data) {
      yield frame;
    }
  }
}

/** v2 实时事件 → Nienie 事件规格：partId 身份与恢复层一致（文本 ${assistantMessageID}:${ordinal}、工具 data.id）。 */
export class V2LiveEventMapper {
  /** partId → 已累计文本长度，供 delta/ended 的 partRevision 水位与补缺。 */
  private readonly accumulated = new Map<string, number>();

  /** 以历史/快照已知长度播种水位（打开生成中的会话时，实时 delta 的 revision 必须续接历史，而不是从 0 重来被门禁丢弃）。 */
  seedPartLength(partId: string, length: number): void {
    if (!partId || length <= 0) return;
    const current = this.accumulated.get(partId) ?? 0;
    if (length > current) this.accumulated.set(partId, length);
  }

  map(frame: V2EventFrame): LiveEventSpec[] {
    const data = frame.data;
    const sessionId = String(data['sessionID'] ?? '');
    if (!sessionId) return [];
    switch (frame.type) {
      case 'session.text.delta':
        return this.streamDelta(data, 'text_delta');
      case 'session.text.ended':
        return this.streamEnded(data, 'text_delta');
      case 'session.reasoning.delta':
        return this.streamDelta(data, 'thinking_delta');
      case 'session.reasoning.ended':
        return this.streamEnded(data, 'thinking_delta');
      case 'session.tool.input.started':
        return this.toolUse(data, 'pending', undefined);
      case 'session.tool.input.ended':
        return this.toolUse(data, 'running', this.parseInputText(data['text']));
      case 'session.tool.called':
        return this.toolUse(data, 'running', asRecord(data['input']));
      case 'session.tool.success': {
        const toolCallId = String(data['id'] ?? '');
        const content = Array.isArray(data['content'])
          ? (data['content'] as Parameters<typeof contentToText>[0])
          : undefined;
        return [
          {
            type: 'tool_result',
            payload: {
              toolCallId,
              content: contentToText(content),
              isError: false,
              partId: toolCallId,
              partRevision: 2,
            },
          },
        ];
      }
      case 'session.tool.failed': {
        const toolCallId = String(data['id'] ?? '');
        const error = asRecord(data['error']);
        const content = Array.isArray(data['content'])
          ? (data['content'] as Parameters<typeof contentToText>[0])
          : undefined;
        const partial = contentToText(content);
        const message = String(error?.['message'] ?? 'tool failed');
        return [
          {
            type: 'tool_result',
            payload: {
              toolCallId,
              content: partial.length > 0 ? `${message}\n${partial}` : message,
              isError: true,
              partId: toolCallId,
              partRevision: 2,
            },
          },
        ];
      }
      case 'session.execution.started':
        return [{ type: 'status', payload: { status: 'running' } }];
      case 'session.execution.succeeded':
        return [{ type: 'status', payload: { status: 'idle' } }];
      case 'session.execution.failed': {
        const error = asRecord(data['error']);
        return [
          {
            type: 'error',
            payload: {
              code: 'EXECUTION_FAILED',
              message: String(error?.['message'] ?? 'Agent execution failed'),
              retryable: true,
            },
          },
          { type: 'status', payload: { status: 'idle' } },
        ];
      }
      case 'session.execution.interrupted':
        return [{ type: 'status', payload: { status: 'cancelled' } }];
      case 'permission.asked': {
        const resources = Array.isArray(data['resources'])
          ? (data['resources'] as unknown[]).map((r) => String(r))
          : [];
        return [
          {
            type: 'status',
            payload: {
              status: 'waiting',
              permissionId: String(data['id'] ?? ''),
              permission: String(data['action'] ?? 'permission'),
              detail: String(data['message'] ?? resources.join(' ') ?? 'Permission requested'),
              patterns: resources,
            },
          },
        ];
      }
      case 'session.usage.updated': {
        const tokens = asRecord(data['tokens']);
        return [
          {
            type: 'usage',
            payload: {
              inputTokens: Number(tokens?.['input'] ?? 0),
              outputTokens: Number(tokens?.['output'] ?? 0),
              costUsd: Number(data['cost'] ?? 0),
            },
          },
        ];
      }
      default:
        return [];
    }
  }

  private streamDelta(
    data: Record<string, unknown>,
    type: 'text_delta' | 'thinking_delta',
  ): LiveEventSpec[] {
    const delta = String(data['delta'] ?? '');
    if (delta.length === 0) return [];
    const partId = this.partId(data);
    const accumulated = (this.accumulated.get(partId) ?? 0) + delta.length;
    this.accumulated.set(partId, accumulated);
    return [{ type, payload: { delta, partId, partRevision: accumulated } }];
  }

  private streamEnded(
    data: Record<string, unknown>,
    type: 'text_delta' | 'thinking_delta',
  ): LiveEventSpec[] {
    const full = String(data['text'] ?? '');
    const partId = this.partId(data);
    const emitted = this.accumulated.get(partId) ?? 0;
    if (full.length <= emitted) return [];
    const delta = full.slice(emitted);
    this.accumulated.set(partId, full.length);
    return [{ type, payload: { delta, partId, partRevision: full.length } }];
  }

  private toolUse(
    data: Record<string, unknown>,
    status: 'pending' | 'running',
    input: Record<string, unknown> | undefined,
  ): LiveEventSpec[] {
    const toolCallId = String(data['id'] ?? '');
    if (!toolCallId) return [];
    return [
      {
        type: 'tool_use',
        payload: {
          toolCallId,
          name: String(data['name'] ?? 'tool'),
          ...(input ? { input } : {}),
          status,
          partId: toolCallId,
          partRevision: 1,
        },
      },
    ];
  }

  private partId(data: Record<string, unknown>): string {
    const assistantMessageID = String(data['assistantMessageID'] ?? '');
    const ordinal = Number(data['ordinal'] ?? 0);
    return `${assistantMessageID}:${ordinal}`;
  }

  private parseInputText(raw: unknown): Record<string, unknown> | undefined {
    if (typeof raw !== 'string') return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return asRecord(parsed) ?? undefined;
    } catch {
      return undefined;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
