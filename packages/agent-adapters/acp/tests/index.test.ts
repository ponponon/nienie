import { describe, expect, it } from 'vitest';
import type { CanonicalAgentEvent } from '@nienie/protocol';
import { AcpAdapter, type AcpTransport } from '../src/index.js';

describe('AcpAdapter', () => {
  it('routes JSON-RPC 2.0 ACP session commands and normalizes session/update notifications', async () => {
    const listeners = new Set<(notification: unknown) => void>();
    const calls: Array<{ method: string; params?: Record<string, unknown> | undefined }> = [];

    const transport: AcpTransport = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') {
          return { agentInfo: { version: '1.2.0' } };
        }
        if (method === 'session/new') {
          return { sessionId: 'acp_ses_01' };
        }
        if (method === 'session/prompt') {
          for (const listener of listeners) {
            listener({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp_ses_01',
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  content: { type: 'text', text: 'Analyzing ACP request' },
                },
              },
            });
            listener({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp_ses_01',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'acp_tool_1',
                  title: 'fs.read',
                  rawInput: { path: 'README.md', token: 'secret-token' },
                },
              },
            });
            listener({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp_ses_01',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'acp_tool_1',
                  status: 'completed',
                  rawOutput: '# Nienie',
                },
              },
            });
            listener({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp_ses_01',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Done reading README.' },
                },
              },
            });
          }
        }
        return {};
      },
      onNotification(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async close() {
        listeners.clear();
      },
    };

    const adapter = new AcpAdapter({ transport });
    const info = await adapter.detect();
    expect(info).toMatchObject({ id: 'acp', available: true, version: '1.2.0' });

    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));

    const session = await adapter.createSession({ title: 'ACP Test', projectPath: '/workspace/acp' });
    expect(session.id).toBe('acp_ses_01');

    await adapter.sendMessage(session.id, 'Read README');
    expect(events.map((e) => ({ seq: e.sequence, type: e.type, payload: e.payload }))).toEqual([
      { seq: 1, type: 'thinking_delta', payload: { delta: 'Analyzing ACP request' } },
      {
        seq: 2,
        type: 'tool_use',
        payload: {
          toolCallId: 'acp_tool_1',
          name: 'fs.read',
          input: { path: 'README.md', token: '[REDACTED]' },
        },
      },
      {
        seq: 3,
        type: 'tool_result',
        payload: {
          toolCallId: 'acp_tool_1',
          content: '# Nienie',
          isError: false,
        },
      },
      { seq: 4, type: 'text_delta', payload: { delta: 'Done reading README.' } },
    ]);
  });
});
