import { describe, expect, it } from 'vitest';
import { OpenCodeAdapter } from '../src/index.js';

type Captured = { method: string; path: string; query: Record<string, string>; body: unknown };

function mockFetch(captured: Captured[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const query = Object.fromEntries(url.searchParams);
    captured.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const path = url.pathname;
    if (path === '/api/info') {
      return json(200, { version: '2.2.5', pid: 28118, urls: [], paths: { tmp: '/tmp' } });
    }
    if (path === '/api/session' && (init?.method ?? 'GET') === 'GET') {
      return json(200, {
        data: [
          {
            id: 'ses_v2',
            projectID: 'p1',
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1760000000000, updated: 1760000001000 },
            title: '桌面会话',
            location: { directory: '/workspace/demo' },
          },
        ],
        cursor: {},
      });
    }
    if (path === '/api/session' && init?.method === 'POST') {
      return json(200, {
        data: {
          id: 'ses_new',
          projectID: 'p1',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1760000002000, updated: 1760000002000 },
          title: '手机建的会话',
          location: { directory: '/workspace/demo' },
        },
      });
    }
    if (path === '/api/session/ses_new/model' && init?.method === 'POST') {
      return new Response(null, { status: 204 });
    }
    if (path === '/api/session/ses_new/prompt' && init?.method === 'POST') {
      return json(200, {
        data: {
          id: 'msg_client_1',
          sessionID: 'ses_new',
          time: { created: 1760000003000 },
          type: 'user',
          payload: { text: '你好' },
          delivery: 'queue',
        },
      });
    }
    if (path === '/api/session/ses_new/interrupt' && init?.method === 'POST') {
      return json(200, { interrupted: true });
    }
    if (path === '/api/session/ses_new/permission/perm_1/reply' && init?.method === 'POST') {
      return new Response(null, { status: 204 });
    }
    if (path === '/api/session/ses_new' && (init?.method ?? 'GET') === 'GET') {
      return json(200, {
        data: {
          id: 'ses_new',
          projectID: 'p1',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1760000002000, updated: 1760000002000 },
          title: '手机建的会话',
          location: { directory: '/workspace/demo' },
        },
      });
    }
    if (path === '/api/session/ses_new/message') {
      return json(200, {
        data: [
          { id: 'msg_u1', time: { created: 1760000004000 }, type: 'user', text: '你好' },
          {
            id: 'msg_a1',
            time: { created: 1760000005000 },
            type: 'assistant',
            agent: 'build',
            model: { id: 'gpt-5.6', providerID: 'openai' },
            content: [
              { type: 'text', text: '好的' },
              {
                type: 'tool',
                id: 'call_1',
                name: 'shell',
                state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'a.ts' }] },
                time: { created: 1760000005100 },
              },
            ],
          },
        ],
        cursor: {},
      });
    }
    if (path === '/api/session/ses_new/diff') {
      return json(200, {
        data: [{ file: 'a.ts', patch: '@@ -1 +1 @@', additions: 1, deletions: 1, status: 'modified' }],
      });
    }
    return json(404, { _tag: 'NotFound', message: `unexpected ${path}` });
  }) as typeof globalThis.fetch;
}

function makeAdapter(captured: Captured[]): OpenCodeAdapter {
  return new OpenCodeAdapter({
    mode: 'v2',
    v2Endpoint: { baseUrl: 'http://127.0.0.1:49374', password: 'pw' },
    fetch: mockFetch(captured),
  } as never);
}

describe('OpenCodeAdapter v2 模式（J0.6b-3c/3d 数据面切换）', () => {
  it('detect/listSessions/createSession 走 v2 Session API', async () => {
    const captured: Captured[] = [];
    const adapter = makeAdapter(captured);
    const info = await adapter.detect();
    expect(info.available).toBe(true);
    expect(info.version).toBe('2.2.5');

    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 'ses_v2', title: '桌面会话', projectPath: '/workspace/demo' });
    expect(captured.find((c) => c.path === '/api/session' && c.method === 'GET')?.query).toMatchObject({
      parentID: 'null',
      order: 'desc',
    });

    const created = await adapter.createSession({ title: '手机建的会话', projectPath: '/workspace/demo' });
    expect(created.id).toBe('ses_new');
    expect(captured.find((c) => c.path === '/api/session' && c.method === 'POST')?.body).toMatchObject({
      title: '手机建的会话',
      location: { directory: '/workspace/demo' },
    });
    await adapter.dispose();
  });

  it('sendMessage 切模型 + prompt 携带 clientMessageId 并校验回显', async () => {
    const captured: Captured[] = [];
    const adapter = makeAdapter(captured);
    const result = await adapter.sendMessage('ses_new', '你好', {
      modelId: 'openai/gpt-5.6',
      clientMessageId: 'msg_client_1',
    });
    expect(result).toEqual({ messageId: 'msg_client_1' });
    expect(captured.find((c) => c.path === '/api/session/ses_new/model')?.body).toEqual({
      model: { id: 'gpt-5.6', providerID: 'openai' },
    });
    expect(captured.find((c) => c.path === '/api/session/ses_new/prompt')?.body).toEqual({
      id: 'msg_client_1',
      text: '你好',
    });
    await adapter.dispose();
  });

  it('clientMessageId 与服务端回显不一致时抛错', async () => {
    const captured: Captured[] = [];
    const adapter = makeAdapter(captured);
    await expect(
      adapter.sendMessage('ses_new', '你好', { clientMessageId: 'msg_other' }),
    ).rejects.toThrow(/mismatch/);
    await adapter.dispose();
  });

  it('cancel/replyPermission 走 v2 interrupt/permission', async () => {
    const captured: Captured[] = [];
    const adapter = makeAdapter(captured);
    await adapter.cancel('ses_new');
    expect(captured.find((c) => c.path === '/api/session/ses_new/interrupt')?.method).toBe('POST');
    await adapter.replyPermission('ses_new', 'perm_1', 'allow_always');
    expect(captured.find((c) => c.path.includes('/permission/perm_1/reply'))?.body).toEqual({
      decision: 'always',
    });
    await adapter.dispose();
  });

  it('loadSession 触发 v2 历史恢复（稳定 eventId）+ getSessionSnapshot 用 Message API', async () => {
    const captured: Captured[] = [];
    const adapter = makeAdapter(captured);
    const events: Array<{ type: string; eventId: string }> = [];
    adapter.onEvent((e) => events.push({ type: e.type, eventId: e.eventId }));
    await adapter.loadSession('ses_new');
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'text_delta', 'tool_use', 'tool_result']);
    expect(events[0]!.eventId).toBe('history:ses_new:msg_u1:0:2');

    const snapshot = await adapter.getSessionSnapshot('ses_new');
    expect(snapshot.parts.map((p) => p.kind)).toEqual(['message', 'message', 'tool_call']);
    expect(snapshot.parts[2]).toMatchObject({ toolCallId: 'call_1', status: 'completed', output: 'a.ts' });
    await adapter.dispose();
  });

  it('getSessionDiff 用真实 turn 范围派生 diffId', async () => {
    const captured: Captured[] = [];
    const adapter = makeAdapter(captured);
    const diffs = await adapter.getSessionDiff('ses_new');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.diffId).toHaveLength(64);
    expect(diffs[0]!.after).toBe('@@ -1 +1 @@');
    const diffCall = captured.find((c) => c.path === '/api/session/ses_new/diff');
    expect(diffCall?.query).toMatchObject({ from: 'msg_u1', to: 'msg_u1' }); // 缺省=最新用户消息 turn
    await adapter.dispose();
  });
});
