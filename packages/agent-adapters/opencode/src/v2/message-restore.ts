import { createHash } from 'node:crypto';
import type { SessionSnapshotPart } from '@nienie/protocol';
import type {
  OpenCodeV2AssistantContentPart,
  OpenCodeV2SessionMessageInfo,
  OpenCodeV2UserMessage,
  OpenCodeV2ToolContent,
  OpenCodeV2ToolState,
} from './types.js';

export type RestoredEventSpec = {
  type: 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result';
  payload: Record<string, unknown>;
};

export type NienieToolStatus = 'pending' | 'running' | 'completed' | 'failed';

export function mapV2ToolStatus(status: OpenCodeV2ToolState['status']): NienieToolStatus {
  switch (status) {
    case 'streaming':
      return 'pending';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'error':
      return 'failed';
  }
}

export function contentToText(content: OpenCodeV2ToolContent[] | undefined): string {
  if (!content) return '';
  return content
    .map((block) => (block.type === 'text' ? block.text : `file:${block.name ?? ''}|${block.uri}`))
    .filter((text) => text.length > 0)
    .join('\n');
}

export function extractToolOutput(state: OpenCodeV2ToolState): { input: Record<string, unknown>; output: string; isError: boolean } {
  switch (state.status) {
    case 'streaming': {
      let input: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(state.input) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        input = {};
      }
      return { input, output: '', isError: false };
    }
    case 'running':
      return { input: state.input, output: '', isError: false };
    case 'completed':
      return { input: state.input, output: contentToText(state.content), isError: false };
    case 'error': {
      const partial = contentToText(state.content);
      const output = partial.length > 0 ? `${state.error.message}\n${partial}` : state.error.message;
      return { input: state.input, output, isError: true };
    }
  }
}

export function userPartId(messageId: string): string {
  return `${messageId}:0`;
}

export function assistantPartId(messageId: string, ordinal: number): string {
  return `${messageId}:${ordinal}`;
}

export type RestoredAttachment = {
  name?: string | undefined;
  mime: string;
  sourceType: 'uri' | 'inline';
  uri?: string | undefined;
  contentHash?: string | undefined;
};

/** 附件结构化保留（J0.6b-3.1）：text 与附件并存时附件不再丢失；inline 数据保留 SHA-256 摘要用于一致性校验。 */
export function userMessageAttachments(message: OpenCodeV2UserMessage): RestoredAttachment[] {
  const out: RestoredAttachment[] = [];
  for (const file of message.files ?? []) {
    const sourceType = file.source !== undefined && file.source.type === 'uri' ? 'uri' : 'inline';
    out.push({
      name: file.name ?? undefined,
      mime: file.mime,
      sourceType,
      uri: sourceType === 'uri' ? (file.source as { type: 'uri'; uri: string }).uri : undefined,
      contentHash: sourceType === 'inline' ? createHash('sha256').update(file.data, 'base64').digest('hex') : undefined,
    });
  }
  return out;
}

/** 用户消息展示文本：有文本时原样返回；仅附件无文本时合成可检索摘要（消息不消失）。 */
export function userMessageText(message: OpenCodeV2UserMessage): string {
  if (message.text.length > 0) return message.text;
  const lines: string[] = [];
  for (const file of message.files ?? []) {
    const uri = file.source !== undefined && file.source.type === 'uri' ? file.source.uri : '(inline)';
    lines.push(`file:${file.name ?? ''}|${uri}|${file.mime}`);
  }
  for (const agent of message.agents ?? []) {
    lines.push(`agent:${agent.name}`);
  }
  for (const skill of message.skills ?? []) {
    lines.push(`skill:${skill.id}`);
  }
  return lines.join('\n');
}

function assertAscending(messages: OpenCodeV2SessionMessageInfo[]): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    if (message.time.created < previous) {
      throw new Error('messages must be in ascending time order');
    }
    previous = message.time.created;
  }
}

/** 将 v2 Message API 的完整消息流转换为 Nienie 历史事件规格（增量全值、稳定 partId/revision）。
 *  期望 messages 按时间升序（GET /message?order=asc 全部分页拼接后的结果）。 */
export function restoreHistoryEvents(messages: OpenCodeV2SessionMessageInfo[]): RestoredEventSpec[] {
  assertAscending(messages);
  const events: RestoredEventSpec[] = [];
  for (const message of messages) {
    if (message.type === 'user') {
      const text = userMessageText(message);
      if (text.length === 0) continue;
      events.push({
        type: 'text_delta',
        payload: {
          delta: text,
          role: 'user',
          partId: userPartId(message.id),
          partRevision: text.length || 1,
          messageId: message.id,
          attachments: userMessageAttachments(message),
          // 显式标记（J0.6b-3.3）：空文本附件消息的合成摘要，不靠文本前缀猜测
          ...(message.text.length === 0 ? { syntheticSummary: true } : {}),
        },
      });
      continue;
    }
    if (message.type !== 'assistant') continue;
    for (let ordinal = 0; ordinal < message.content.length; ordinal += 1) {
      const part = message.content[ordinal] as OpenCodeV2AssistantContentPart;
      const partId = assistantPartId(message.id, ordinal);
      if (part.type === 'text') {
        if (part.text.length === 0) continue;
        events.push({
          type: 'text_delta',
          payload: {
            delta: part.text,
            partId,
            partRevision: part.text.length || 1,
            messageId: message.id,
          },
        });
      } else if (part.type === 'reasoning') {
        if (part.text.length === 0) continue;
        events.push({
          type: 'thinking_delta',
          payload: {
            delta: part.text,
            partId,
            partRevision: part.text.length || 1,
            messageId: message.id,
          },
        });
      } else if (part.type === 'tool') {
        const { input, output, isError } = extractToolOutput(part.state);
        events.push({
          type: 'tool_use',
          payload: {
            toolCallId: part.id,
            name: part.name,
            input,
            status: mapV2ToolStatus(part.state.status),
            partId: part.id,
            partRevision: 1,
            messageId: message.id,
          },
        });
        if (part.state.status === 'completed' || part.state.status === 'error') {
          events.push({
            type: 'tool_result',
            payload: {
              toolCallId: part.id,
              content: output,
              isError,
              partId: part.id,
              partRevision: 2,
              messageId: message.id,
            },
          });
        }
      }
    }
  }
  return events;
}

/** 将 v2 消息转换为 SessionSnapshot Part（快照是状态：全量、按序、带显式 status）。 */
export function buildSnapshotParts(messages: OpenCodeV2SessionMessageInfo[]): SessionSnapshotPart[] {
  assertAscending(messages);
  const parts: SessionSnapshotPart[] = [];
  let ordinal = 0;
  const stamp = () => ({ ordinal: ordinal++, createdAt: '', updatedAt: '' });
  for (const message of messages) {
    const createdAt = new Date(message.time.created).toISOString();
    const base = () => ({ ...stamp(), createdAt, updatedAt: createdAt });
    if (message.type === 'user') {
      const text = userMessageText(message);
      if (text.length === 0) continue;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'resource'; uri: string; name?: string | undefined; mimeType?: string | undefined }
      > = [{ type: 'text', text }];
      for (const attachment of userMessageAttachments(message)) {
        content.push({
          type: 'resource',
          uri: attachment.uri ?? `inline:${attachment.contentHash ?? ''}`,
          name: attachment.name,
          mimeType: attachment.mime,
        });
      }
      parts.push({
        ...base(),
        kind: 'message',
        messageId: message.id,
        role: 'user',
        content,
        partId: userPartId(message.id),
        revision: text.length || 1,
      });
      continue;
    }
    if (message.type !== 'assistant') continue;
    for (let index = 0; index < message.content.length; index += 1) {
      const part = message.content[index] as OpenCodeV2AssistantContentPart;
      const partId = assistantPartId(message.id, index);
      if (part.type === 'text') {
        if (part.text.length === 0) continue;
        parts.push({
          ...base(),
          kind: 'message',
          messageId: message.id,
          role: 'assistant',
          content: [{ type: 'text', text: part.text }],
          partId,
          revision: part.text.length || 1,
        });
      } else if (part.type === 'reasoning') {
        if (part.text.length === 0) continue;
        parts.push({
          ...base(),
          kind: 'thinking',
          content: part.text,
          partId,
          revision: part.text.length || 1,
        });
      } else if (part.type === 'tool') {
        const { input, output, isError } = extractToolOutput(part.state);
        const terminal = part.state.status === 'completed' || part.state.status === 'error';
        // Round 2：Tool Part 用自身 time.created/ran/completed（不沿用 Message 时间）
        const toolCreated = new Date(part.time.created).toISOString();
        const toolEnded =
          part.time.completed != null
            ? new Date(part.time.completed).toISOString()
            : part.time.ran != null
              ? new Date(part.time.ran).toISOString()
              : toolCreated;
        parts.push({
          ...base(),
          createdAt: toolCreated,
          updatedAt: toolEnded,
          kind: 'tool_call',
          toolCallId: part.id,
          name: part.name,
          input,
          status: mapV2ToolStatus(part.state.status),
          ...(output ? { output } : {}),
          isError,
          partId: part.id,
          revision: terminal ? 2 : 1,
        });
      }
    }
  }
  return parts;
}

export type DiffTurnRange = { fromMessageId: string; toMessageId: string };

/** 解析 Diff 的实际生效 turn 范围：from 缺省=最新用户消息，to 缺省=from 自身；
 *  返回解析后的真实 User Message ID，供 diffId 稳定派生使用。 */
export function resolveDiffTurnRange(
  messages: OpenCodeV2SessionMessageInfo[],
  from?: string | undefined,
  to?: string | undefined,
): DiffTurnRange {
  assertAscending(messages);
  const userIds = messages.filter((m) => m.type === 'user').map((m) => m.id);
  if (userIds.length === 0) {
    throw new Error('Cannot resolve diff range: session has no user messages');
  }
  const fromId = from ?? userIds[userIds.length - 1]!;
  const toId = to ?? fromId;
  const fromIndex = userIds.indexOf(fromId);
  const toIndex = userIds.indexOf(toId);
  if (fromIndex < 0) throw new Error(`Cannot resolve diff range: from message ${fromId} is not a user message`);
  if (toIndex < 0) throw new Error(`Cannot resolve diff range: to message ${toId} is not a user message`);
  if (toIndex < fromIndex) throw new Error(`Cannot resolve diff range: to message ${toId} is before from message ${fromId}`);
  return { fromMessageId: fromId, toMessageId: toId };
}
