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
    // F4：initialize 优先协商 protocolVersion 2（携带合规 info/capabilities）；Agent 未回显 2 → v1 语义（派发即送达）
    expect(calls[0]!.method).toBe('initialize');
    expect(calls[0]!.params).toMatchObject({
      protocolVersion: 2,
      info: { name: 'nienie-bridge' },
      capabilities: {},
    });
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
      // v1：prompt 响应=turn 完成 → 派发语义下以 status 事件补报结束
      { seq: 5, type: 'status', payload: { status: 'idle', detail: 'ACP turn completed' } },
    ]);
  });

  it('F4 v2：session/prompt 插入即返回 messageId（接受语义），不做 turn 级等待', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> | undefined }> = [];
    const transport: AcpTransport = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') {
          // F4-A：v2 协议形态——info（非 agentInfo）
          return {
            protocolVersion: 2,
            info: { name: 'demo-agent', title: 'Demo Agent', version: '2.0.0' },
            capabilities: {},
          };
        }
        if (method === 'session/new') {
          return { sessionId: 'acp_ses_v2' };
        }
        if (method === 'session/load' || method === 'session/resume') {
          return {};
        }
        if (method === 'session/prompt') {
          return { messageId: 'msg_user_42' };
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };

    const adapter = new AcpAdapter({ transport });
    const info = await adapter.detect();
    // F4-A：v2 从 info.version 读取（agentInfo 是 v1 字段）
    expect(info.version).toBe('2.0.0');

    const session = await adapter.createSession({ title: 'V2', projectPath: '/workspace/acp' });
    const result = await adapter.sendMessage(session.id, 'hello');
    expect(result).toEqual({ messageId: 'msg_user_42' });
    // 接受即返回：不等待 turn 完成
    expect(calls.filter((c) => c.method === 'session/prompt')).toHaveLength(1);

    // F4-B：v2 恢复会话用 session/resume + replayFrom start（session/load 已废弃）
    await adapter.loadSession('acp_ses_v2');
    const resumeCall = calls.find((c) => c.method === 'session/resume');
    expect(resumeCall).toBeDefined();
    expect(resumeCall!.params).toMatchObject({
      sessionId: 'acp_ses_v2',
      replayFrom: { type: 'start' },
    });
    expect(calls.some((c) => c.method === 'session/load')).toBe(false);
  });

  it('F4-C v2：prompt 响应缺 messageId 视为协议违规，拒绝假送达', async () => {
    const transport: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          return {
            protocolVersion: 2,
            info: { name: 'demo', title: 'Demo', version: '2.0.0' },
            capabilities: {},
          };
        }
        if (method === 'session/new') {
          return { sessionId: 'acp_ses_bad' };
        }
        return {}; // prompt 返回空对象——缺 messageId
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };
    const adapter = new AcpAdapter({ transport });
    await adapter.detect();
    const session = await adapter.createSession({ title: 'Bad', projectPath: '/workspace/acp' });
    await expect(adapter.sendMessage(session.id, 'hi')).rejects.toThrow(/messageId/);
  });

  it('F4-A v2 initialize 被拒（JSON-RPC 错误带 code）回落 v1；传输层错误不盲目重试', async () => {
    let initCount = 0;
    const transport: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          initCount++;
          if (initCount === 1) {
            throw { code: -32602, message: 'unsupported protocolVersion' }; // 协议拒绝
          }
          return { protocolVersion: 1, agentInfo: { version: '1.0.0' } };
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };
    const adapter = new AcpAdapter({ transport });
    const info = await adapter.detect();
    expect(info.available).toBe(true);
    expect(info.version).toBe('1.0.0');
    expect(initCount).toBe(2); // v2 被拒 → v1 重试

    // 传输层错误（无 code）不重试 initialize
    let initCount2 = 0;
    const broken: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          initCount2++;
          throw new Error('socket closed');
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };
    const adapter2 = new AcpAdapter({ transport: broken });
    const info2 = await adapter2.detect();
    expect(info2.available).toBe(false);
    expect(initCount2).toBe(1);
  });

  it('F4-D requires_action 映射 waiting（不显示 Thinking）', async () => {
    const listeners = new Set<(notification: unknown) => void>();
    const transport: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          return {
            protocolVersion: 2,
            info: { name: 'demo', title: 'Demo', version: '2.0.0' },
            capabilities: {},
          };
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
    await adapter.detect();
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    for (const listener of listeners) {
      listener({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp_ses_act',
          update: { sessionUpdate: 'state_update', state: 'requires_action' },
        },
      });
    }
    const st = events.find((e) => e.type === 'status');
    expect(st!.payload?.status).toBe('waiting');
  });

  it('F4 v1：派发即送达，turn 失败经 error+status 事件上报（不谎称 RPC 返回=接受）', async () => {
    const listeners = new Set<(notification: unknown) => void>();
    let rejectPrompt: ((err: Error) => void) | undefined;
    const transport: AcpTransport = {
      async request(method, params) {
        if (method === 'initialize') {
          return { protocolVersion: 1, agentInfo: { version: '1.0.0' } };
        }
        if (method === 'session/new') {
          return { sessionId: 'acp_ses_v1' };
        }
        if (method === 'session/prompt') {
          return new Promise((_resolve, reject) => {
            rejectPrompt = reject;
          });
        }
        void params;
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
    await adapter.detect();
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    const session = await adapter.createSession({ title: 'V1', projectPath: '/workspace/acp' });

    // prompt 还在 pending（turn 未完成）→ sendMessage 已返回（派发即送达）
    void adapter.sendMessage(session.id, 'hello');
    await new Promise((r) => setTimeout(r, 0));
    expect(rejectPrompt).toBeDefined();

    rejectPrompt!(new Error('provider outage'));
    await new Promise((r) => setTimeout(r, 0));
    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    expect(types).toContain('status');
    const errEvent = events.find((e) => e.type === 'error');
    expect(String(errEvent!.payload?.message)).toContain('provider outage');
    const failed = events.find((e) => e.type === 'status' && e.payload?.status === 'failed');
    expect(failed).toBeDefined();
  });

  it('F4 v2：state_update idle/stopReason=error 触发 error+failed 事件', async () => {
    const listeners = new Set<(notification: unknown) => void>();
    const transport: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          return { protocolVersion: 2, agentInfo: { version: '2.0.0' } };
        }
        if (method === 'session/new') {
          return { sessionId: 'acp_ses_v2b' };
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
    await adapter.detect();
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));

    for (const listener of listeners) {
      listener({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp_ses_v2b',
          update: {
            sessionUpdate: 'state_update',
            state: 'idle',
            stopReason: 'error',
            error: { code: -32000, message: 'Authentication required' },
          },
        },
      });
    }

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(String(errEvent!.payload?.message)).toContain('Authentication required');
    const failed = events.find((e) => e.type === 'status' && e.payload?.status === 'failed');
    expect(failed).toBeDefined();
  });
});
