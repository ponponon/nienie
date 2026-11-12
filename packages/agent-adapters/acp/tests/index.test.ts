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
    expect(events.map((e) => ({ seq: e.sequence, type: e.type }))).toEqual([
      { seq: 1, type: 'thinking_delta' },
      { seq: 2, type: 'tool_use' },
      { seq: 3, type: 'tool_result' },
      { seq: 4, type: 'text_delta' },
      // v1：prompt 响应=turn 完成 → 派发语义下以 status 事件补报结束
      { seq: 5, type: 'status' },
    ]);
    expect(events[0]!.payload.delta).toBe('Analyzing ACP request');
    expect(events[1]!.payload).toMatchObject({
      toolCallId: 'acp_tool_1',
      name: 'fs.read',
      input: { path: 'README.md', token: '[REDACTED]' },
    });
    expect(events[2]!.payload).toMatchObject({
      toolCallId: 'acp_tool_1',
      content: '# Nienie',
      isError: false,
    });
    expect(events[3]!.payload).toMatchObject({ delta: 'Done reading README.', role: 'assistant' });
    expect(events[4]!.payload).toMatchObject({ status: 'idle' });
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

  it('F4-1 真 v1-only Agent 全流程：-32022 → 关闭原连接 → 新连接 v1 initialize（clientInfo）→ prompt', async () => {
    // 原连接：v2 initialize 被拒（-32022 结构化版本信息：支持 1）
    let oldClosed = false;
    const oldTransport: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          throw {
            code: -32022,
            message: 'unsupported protocol version',
            data: { requested: 2, supported: [1] },
          };
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {
        oldClosed = true;
      },
    };
    // 新连接：v1-only Agent（initialize 返回 protocolVersion 1，prompt 走 turn 语义）
    const newCalls: Array<{ method: string; params?: Record<string, unknown> | undefined }> = [];
    const notifyListeners = new Set<(notification: unknown) => void>();
    let unsubscribed = false;
    const newTransport: AcpTransport = {
      async request(method, params) {
        newCalls.push({ method, params });
        if (method === 'initialize') {
          return { protocolVersion: 1, agentInfo: { version: '1.0.0' } };
        }
        if (method === 'session/new') {
          return { sessionId: 'v1_ses' };
        }
        return {};
      },
      onNotification(listener) {
        notifyListeners.add(listener);
        return () => {
          unsubscribed = true;
          notifyListeners.delete(listener);
        };
      },
      async close() {},
    };

    const adapter = new AcpAdapter({
      transport: oldTransport,
      reconnect: async () => newTransport,
    });
    const info = await adapter.detect();
    expect(info.available).toBe(true);
    expect(info.version).toBe('1.0.0');
    expect(oldClosed).toBe(true); // 原连接已关闭（一个连接只协商一个版本）
    // v1 initialize 在**新连接**上、使用 v1 参数形态
    const init = newCalls.find((c) => c.method === 'initialize');
    expect(init!.params).toMatchObject({
      protocolVersion: 1,
      clientInfo: { name: 'nienie-bridge' },
      clientCapabilities: {},
    });
    expect(init!.params).not.toHaveProperty('info');

    // v1 后续 session/prompt 全流程可用
    const session = await adapter.createSession({ title: 'V1', projectPath: '/workspace/v1' });
    expect(session.id).toBe('v1_ses');
    void adapter.sendMessage(session.id, 'hello'); // v1 派发语义
    await new Promise((r) => setTimeout(r, 0));
    expect(newCalls.some((c) => c.method === 'session/prompt')).toBe(true);

    // F4-1（P1）：新连接必须重新注册通知监听——session/update 真正进入 onEvent
    const events: CanonicalAgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    expect(notifyListeners.size).toBe(1); // 新连接已挂监听（旧连接的已退订）
    for (const listener of notifyListeners) {
      listener({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'v1_ses',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: [{ type: 'text', text: 'v1 reply' }],
          },
        },
      });
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.payload?.delta).toBe('v1 reply');

    // dispose 正确取消新连接订阅
    await adapter.dispose();
    expect(unsubscribed).toBe(true);
    expect(notifyListeners.size).toBe(0);
  });

  it('F4-1 -32022 明确不支持 v1 / 网络错误 / 无 reconnect 工厂都不回落', async () => {
    // supported 缺失：fail-closed 不回落（不得推测 Agent 支持 v1）
    let missingInit = 0;
    const missing: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          missingInit++;
          throw { code: -32022, message: 'x', data: { requested: 2 } };
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };
    const a0 = new AcpAdapter({ transport: missing, reconnect: async () => missing });
    expect((await a0.detect()).available).toBe(false);
    expect(missingInit).toBe(1);

    // supported 不含 1：回落无意义
    const noV1: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          throw { code: -32022, message: 'x', data: { requested: 2, supported: [2] } };
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };
    const a1 = new AcpAdapter({ transport: noV1 });
    expect((await a1.detect()).available).toBe(false);

    // 网络错误（字符串 code）不回落
    let initCount = 0;
    const broken: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          initCount++;
          throw { code: 'ECONNRESET', message: 'socket hang up' };
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };
    const a2 = new AcpAdapter({ transport: broken });
    expect((await a2.detect()).available).toBe(false);
    expect(initCount).toBe(1);

    // -32602/-32600 不是版本信号，不回落
    let initCount3 = 0;
    const paramsErr: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          initCount3++;
          throw { code: -32602, message: 'invalid params' };
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };
    const a3 = new AcpAdapter({ transport: paramsErr });
    expect((await a3.detect()).available).toBe(false);
    expect(initCount3).toBe(1);

    // 无 reconnect 工厂：不重复 initialize，明确报错
    const v2reject: AcpTransport = {
      async request(method) {
        if (method === 'initialize') {
          throw { code: -32022, message: 'x', data: { requested: 2, supported: [1] } };
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };
    const a4 = new AcpAdapter({ transport: v2reject });
    expect((await a4.detect()).available).toBe(false);
  });

  it('F4-2 v2 真实数据结构归约：ContentBlock[] upsert / ToolCallContent 替换与追加 / Session 隔离', async () => {
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
    const emit = (sessionId: string, update: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update },
        });
      }
    };

    // 官方 v2 真实形态：content 为 ContentBlock[]、带 messageId
    emit('ses_a', {
      sessionUpdate: 'user_message',
      messageId: 'msg_001',
      content: [{ type: 'text', text: '帮我修 bug' }],
    });
    emit('ses_a', {
      sessionUpdate: 'user_message_chunk',
      messageId: 'msg_001',
      content: [{ type: 'text', text: '（补充）' }],
    });
    // upsert 覆盖：最后一次完整消息替换之前内容
    emit('ses_a', {
      sessionUpdate: 'user_message',
      messageId: 'msg_001',
      content: [{ type: 'text', text: 'corrected' }],
    });
    emit('ses_a', {
      sessionUpdate: 'agent_message',
      messageId: 'msg_002',
      content: [{ type: 'text', text: '好的' }],
    });

    const userItems = events.filter(
      (e) => e.type === 'text_delta' && e.payload?.role === 'user',
    );
    // chunk 追加 + upsert 替换：最终文本 = corrected（full 覆盖），此前有增量与完整两条
    expect(userItems[0]!.payload).toMatchObject({
      delta: '帮我修 bug',
      full: true,
      messageId: 'msg_001',
      partId: 'msg_001',
    });
    expect(userItems[1]!.payload).toMatchObject({ delta: '（补充）', messageId: 'msg_001' });
    expect(userItems[1]!.payload!.full).toBeUndefined(); // chunk 是追加不是覆盖
    expect(userItems[2]!.payload).toMatchObject({ delta: 'corrected', full: true });
    const asst = events.find((e) => e.payload?.role === 'assistant');
    expect(asst!.payload).toMatchObject({ delta: '好的', full: true, messageId: 'msg_002' });

    // 工具：tool_call_update 创建 + content 替换/追加（ToolCallContent 真实形态）
    emit('ses_a', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_001',
      title: 'fs.read',
      status: 'running',
      rawInput: { path: 'a.ts' },
    });
    emit('ses_a', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_001',
      status: 'running',
      content: [{ type: 'content', content: { type: 'text', text: 'v1 content' } }],
    });
    emit('ses_a', {
      sessionUpdate: 'tool_call_content_chunk',
      toolCallId: 'call_001',
      content: { type: 'content', content: { type: 'text', text: '+more' } },
    });
    emit('ses_a', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_001',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'final output' } }],
    });

    const toolUses = events.filter((e) => e.type === 'tool_use');
    expect(toolUses).toHaveLength(1); // (session, toolCallId) 只创建一次
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(String(toolResults[0]!.payload?.content)).toBe('v1 content'); // update.content 整体替换
    expect(String(toolResults[1]!.payload?.content)).toBe('v1 content+more'); // chunk 追加
    expect(String(toolResults[2]!.payload?.content)).toBe('final output'); // 终态再替换

    // Session 隔离：不同 session 的同名 toolCallId 互不干扰
    emit('ses_b', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_001',
      title: 'other',
      status: 'running',
    });
    const usesAll = events.filter((e) => e.type === 'tool_use');
    expect(usesAll).toHaveLength(2); // ses_b 的 call_001 独立创建
    emit('ses_b', {
      sessionUpdate: 'tool_call_content_chunk',
      toolCallId: 'call_001',
      content: { type: 'content', content: { type: 'text', text: 'B-only' } },
    });
    const lastResult = events.filter((e) => e.type === 'tool_result').at(-1);
    expect(String(lastResult!.payload?.content)).toBe('B-only'); // 不与 ses_a 内容混合
  });

  it('F4-2 清空语义：content 缺失=保留 / null、[]=清空（消息+工具），diff/terminal 不静默丢', async () => {
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
    const emit = (sessionId: string, update: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update },
        });
      }
    };

    // 消息：非空 → content:[] 清空 → 新 chunk
    emit('ses_c', {
      sessionUpdate: 'agent_message',
      messageId: 'mm1',
      content: [{ type: 'text', text: 'hello world' }],
    });
    emit('ses_c', {
      sessionUpdate: 'agent_message',
      messageId: 'mm1',
      content: [], // 清空
    });
    emit('ses_c', {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'mm1',
      content: [{ type: 'text', text: 'fresh' }],
    });
    const msgEvents = events.filter((e) => e.type === 'text_delta');
    expect(msgEvents).toHaveLength(3);
    expect(msgEvents[1]!.payload).toMatchObject({ delta: '', full: true, messageId: 'mm1' }); // 清空事件
    expect(msgEvents[2]!.payload).toMatchObject({ delta: 'fresh' });

    // content 字段缺失 = 保留（不产生事件）
    emit('ses_c', {
      sessionUpdate: 'agent_message',
      messageId: 'mm1',
      status: 'x',
    } as Record<string, unknown>);
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(3);

    // content:null = 清空
    emit('ses_c', {
      sessionUpdate: 'agent_message',
      messageId: 'mm1',
      content: null,
    } as unknown as Record<string, unknown>);
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(4);

    // 工具：content:null 清空（即使 running 也要发 tool_result）
    emit('ses_c', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      title: 't',
      status: 'running',
    });
    emit('ses_c', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'running',
      content: [{ type: 'content', content: { type: 'text', text: 'old' } }],
    });
    emit('ses_c', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'running',
      content: null, // 清空
    } as unknown as Record<string, unknown>);
    const tResults = events.filter((e) => e.type === 'tool_result');
    expect(String(tResults.at(-1)!.payload?.content)).toBe('');

    // diff 内容不静默丢：patch.text + changes 摘要
    emit('ses_c', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      content: [
        {
          type: 'diff',
          changes: [{ operation: 'modify', path: '/workspace/a.ts', fileType: 'text' }],
          patch: { format: 'git_patch', text: '--- a.ts\n+++ a.ts' },
        },
      ],
    });
    const diffResult = events.filter((e) => e.type === 'tool_result').at(-1)!;
    expect(String(diffResult.payload?.content)).toContain('modify /workspace/a.ts');
    expect(String(diffResult.payload?.content)).toContain('--- a.ts');

    // terminal 类型明确标注不支持，不静默丢
    emit('ses_c', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      content: [{ type: 'terminal', terminalId: 't1' }],
    });
    const termResult = events.filter((e) => e.type === 'tool_result').at(-1)!;
    expect(String(termResult.payload?.content)).toContain('terminal');
  });

  it('F4-3 session/resume 使用会话已有 projectPath（不传错工作目录）', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> | undefined }> = [];
    const transport: AcpTransport = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') {
          return {
            protocolVersion: 2,
            info: { name: 'demo', title: 'Demo', version: '2.0.0' },
            capabilities: {},
          };
        }
        if (method === 'session/new') {
          return { sessionId: 'acp_ses_cwd' };
        }
        return {};
      },
      onNotification() {
        return () => undefined;
      },
      async close() {},
    };
    const adapter = new AcpAdapter({ transport, defaultProjectPath: '/default/cwd' });
    await adapter.detect();
    await adapter.createSession({ title: 'Cwd', projectPath: '/workspace/custom' });
    await adapter.loadSession('acp_ses_cwd');
    const resume = calls.find((c) => c.method === 'session/resume');
    expect(resume!.params!.cwd).toBe('/workspace/custom');
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
