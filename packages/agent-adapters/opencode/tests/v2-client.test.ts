import { describe, expect, it } from 'vitest';
import { OpenCodeV2Client, OpenCodeV2ClientError } from '../src/v2/client.js';

type CapturedRequest = {
  method: string;
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  redirect: RequestRedirect | undefined;
  body: unknown;
};

function mockFetch(
  responder: (req: { method: string; path: string; search: URLSearchParams }) => Response | Promise<Response>,
  captured: CapturedRequest[] = [],
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const req = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      search: url.searchParams,
    };
    captured.push({
      method: req.method,
      url: url.toString(),
      auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
      contentType: (init?.headers as Record<string, string> | undefined)?.['content-type'],
      redirect: init?.redirect,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return responder(req);
  }) as typeof globalThis.fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const sessionInfo = {
  id: 'ses_1',
  projectID: 'proj_1',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1760000000000, updated: 1760000000000 },
  title: 'Mobile Session',
  location: { directory: '/workspace/nienie' },
};

describe('OpenCodeV2Client', () => {
  it('getServerInfo sends Basic auth and refuses redirects', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      password: 'secret-password',
      fetch: mockFetch(() => json(200, { version: '2.2.5', pid: 28118, urls: [], paths: { tmp: '/tmp' } }), captured),
    });
    const info = await client.getServerInfo();
    expect(info.version).toBe('2.2.5');
    expect(captured[0]).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:49374/api/info',
      auth: `Basic ${Buffer.from('opencode:secret-password').toString('base64')}`,
      redirect: 'error',
    });
  });

  it('sends no authorization header without a password', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { version: '2.2.5', pid: 28118, urls: [], paths: { tmp: '/tmp' } }), captured),
    });
    await client.getServerInfo();
    expect(captured[0]?.auth).toBeUndefined();
  });

  it('listSessions encodes flat query params and returns the cursor pair', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(
        () => json(200, { data: [sessionInfo], cursor: { next: 'cursor_next', previous: 'cursor_prev' } }),
        captured,
      ),
    });
    const page = await client.listSessions({
      limit: 20,
      order: 'desc',
      search: 'ideaboom',
      parentID: 'null',
      archived: false,
      directory: '/workspace/nienie',
      subpath: 'src',
      cursor: 'cursor_prev',
    });
    expect(page.data).toEqual([sessionInfo]);
    expect(page.cursor.next).toBe('cursor_next');
    const search = new URL(captured[0]!.url).searchParams;
    expect(Object.fromEntries(search)).toEqual({
      limit: '20',
      order: 'desc',
      search: 'ideaboom',
      parentID: 'null',
      archived: 'false',
      directory: '/workspace/nienie',
      subpath: 'src',
      cursor: 'cursor_prev',
    });
  });

  it('createSession sends the v2 body shape and unwraps data', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { data: sessionInfo }), captured),
    });
    const created = await client.createSession({
      title: 'Mobile Session',
      location: { directory: '/workspace/nienie' },
      model: { id: 'claude-sonnet-4', providerID: 'anthropic' },
    });
    expect(created.id).toBe('ses_1');
    expect(captured[0]).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:49374/api/session',
      contentType: 'application/json',
      body: {
        title: 'Mobile Session',
        location: { directory: '/workspace/nienie' },
        model: { id: 'claude-sonnet-4', providerID: 'anthropic' },
      },
    });
  });

  it('getSession URL-encodes the session id', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { data: sessionInfo }), captured),
    });
    await client.getSession('ses a/b?c');
    expect(new URL(captured[0]!.url).pathname).toBe('/api/session/ses%20a%2Fb%3Fc');
  });

  it('deleteSession treats 204 as success with no body', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => new Response(null, { status: 204 }), captured),
    });
    await expect(client.deleteSession('ses_1')).resolves.toBeUndefined();
    expect(captured[0]).toMatchObject({ method: 'DELETE', url: 'http://127.0.0.1:49374/api/session/ses_1' });
  });

  it('listModels uses location[directory] and repeats types params', async () => {
    const captured: CapturedRequest[] = [];
    const modelInfo = { id: 'anthropic/claude-sonnet-4', modelID: 'claude-sonnet-4', providerID: 'anthropic' };
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(
        () => json(200, { location: { directory: '/workspace/nienie' }, data: [modelInfo] }),
        captured,
      ),
    });
    const result = await client.listModels({ directory: '/workspace/nienie', types: ['chat', 'agent'] });
    expect(result.location.directory).toBe('/workspace/nienie');
    expect(result.data).toEqual([modelInfo]);
    const url = new URL(captured[0]!.url);
    expect(url.searchParams.get('location[directory]')).toBe('/workspace/nienie');
    expect(url.searchParams.getAll('types')).toEqual(['chat', 'agent']);
  });

  it('getDefaultModel accepts a null model', async () => {
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { location: { directory: '/w' }, data: null })),
    });
    const result = await client.getDefaultModel({ directory: '/w' });
    expect(result.data).toBeNull();
  });

  it('listProviders unwraps the location response', async () => {
    const provider = { id: 'anthropic', name: 'Anthropic', activation: 'enabled', package: '@opencode/anthropic' };
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { location: { directory: '/w' }, data: [provider] })),
    });
    const result = await client.listProviders();
    expect(result.data).toEqual([provider]);
  });

  it('switchModel posts {model:{id,providerID}} and expects 204', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => new Response(null, { status: 204 }), captured),
    });
    await client.switchModel('ses_1', { id: 'gpt-5.6', providerID: 'openai', variant: 'high' });
    expect(captured[0]).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:49374/api/session/ses_1/model',
      body: { model: { id: 'gpt-5.6', providerID: 'openai', variant: 'high' } },
    });
  });

  it('prompt sends the v2 PromptInput shape and returns the queued inbox message', async () => {
    const captured: CapturedRequest[] = [];
    const inbox = {
      id: 'msg_1',
      sessionID: 'ses_1',
      time: { created: 1760000000000 },
      type: 'user',
      payload: { text: '帮我分析这个项目' },
      delivery: 'queue',
    };
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { data: inbox }), captured),
    });
    const result = await client.prompt('ses_1', {
      text: '帮我分析这个项目',
      files: [{ uri: 'file:///w/a.ts', name: 'a.ts' }],
      agents: [{ name: 'explore' }],
      skills: [{ id: 'skill_1' }],
      metadata: { source: 'mobile' },
      delivery: 'queue',
      resume: false,
    });
    expect(result).toEqual(inbox);
    expect(captured[0]).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:49374/api/session/ses_1/prompt',
      body: {
        text: '帮我分析这个项目',
        files: [{ uri: 'file:///w/a.ts', name: 'a.ts' }],
        agents: [{ name: 'explore' }],
        skills: [{ id: 'skill_1' }],
        metadata: { source: 'mobile' },
        delivery: 'queue',
        resume: false,
      },
    });
    expect(captured[0]?.body).not.toHaveProperty('model');
    expect(result.type).toBe('user');
  });

  it('interrupt sends resume as a string query and returns the interrupted flag', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { interrupted: true }), captured),
    });
    const result = await client.interrupt('ses_1', { resume: true });
    expect(result.interrupted).toBe(true);
    expect(new URL(captured[0]!.url).searchParams.get('resume')).toBe('true');
    expect(captured[0]?.body).toBeUndefined();
  });

  it('replyPermission URL-encodes the request id and maps decisions', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => new Response(null, { status: 204 }), captured),
    });
    await client.replyPermission('ses_1', 'perm/1', 'once');
    await client.replyPermission('ses_1', 'perm_2', 'reject', 'not allowed');
    expect(captured[0]).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:49374/api/session/ses_1/permission/perm%2F1/reply',
      body: { decision: 'once' },
    });
    expect(captured[1]).toMatchObject({ body: { decision: 'reject', message: 'not allowed' } });
  });

  it('throws OpenCodeV2ClientError with tag and message from error bodies', async () => {
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(404, { _tag: 'SessionNotFoundError', sessionID: 'ses_1', message: 'Session not found' })),
    });
    const error = await client.getSession('ses_1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenCodeV2ClientError);
    expect(error).toMatchObject({ status: 404, tag: 'SessionNotFoundError', message: 'Session not found' });
  });

  it('keeps a status-based message for non-JSON error bodies', async () => {
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => new Response('<html>boom</html>', { status: 500 })),
    });
    const error = await client.getServerInfo().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 500, tag: undefined });
    expect((error as OpenCodeV2ClientError).message).toContain('500');
  });

  it('wraps network failures as status 0 errors', async () => {
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof globalThis.fetch,
    });
    const error = await client.getServerInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenCodeV2ClientError);
    expect(error).toMatchObject({ status: 0, message: 'ECONNREFUSED' });
  });

  it('getDefaultModel and listProviders never send a types param', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { location: { directory: '/w' }, data: [] }), captured),
    });
    await client.getDefaultModel({ directory: '/w' });
    await client.listProviders({ directory: '/w' });
    for (const request of captured) {
      const url = new URL(request.url);
      expect([...url.searchParams.keys()]).toEqual(['location[directory]']);
    }
  });

  it('preserves error tags across statuses (409 ConflictError, 400 InvalidCursorError)', async () => {
    const conflict = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(409, { _tag: 'ConflictError', message: 'Session is busy', resource: 'ses_1' })),
    });
    const cursor = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(400, { _tag: 'InvalidCursorError', message: 'Cursor is invalid' })),
    });
    expect(await conflict.prompt('ses_1', { text: 'hi' }).catch((e: unknown) => e)).toMatchObject({
      status: 409,
      tag: 'ConflictError',
      message: 'Session is busy',
    });
    expect(await cursor.listSessions({ cursor: 'bad' }).catch((e: unknown) => e)).toMatchObject({
      status: 400,
      tag: 'InvalidCursorError',
    });
  });

  it('rejects a non-204 success with an empty body instead of returning undefined', async () => {
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => new Response('', { status: 200 })),
    });
    const error = await client.getSession('ses_1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenCodeV2ClientError);
    expect(error).toMatchObject({ status: 200, message: expect.stringContaining('empty response body') });
  });

  it('wraps invalid JSON success bodies while keeping the HTTP status', async () => {
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => new Response('<html>oops</html>', { status: 200 })),
    });
    const error = await client.getSession('ses_1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenCodeV2ClientError);
    expect(error).toMatchObject({ status: 200, message: expect.stringContaining('invalid JSON') });
  });

  it('wraps response body read failures as transport errors', async () => {
    const brokenBody = {
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('socket hang up');
      },
    } as unknown as Response;
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: (async () => brokenBody) as typeof globalThis.fetch,
    });
    const error = await client.getSession('ses_1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenCodeV2ClientError);
    expect(error).toMatchObject({ status: 0, message: expect.stringContaining('socket hang up') });
  });

  it('wraps request timeouts as status 0 errors', async () => {
    const hangingFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      })) as typeof globalThis.fetch;
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: hangingFetch,
      timeoutMs: 5,
    });
    const error = await client.getServerInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenCodeV2ClientError);
    expect(error).toMatchObject({ status: 0 });
  });

  it('refuses to construct with a non-local or non-root baseUrl', () => {
    expect(() => new OpenCodeV2Client({ baseUrl: 'https://attacker.example' })).toThrow(OpenCodeV2ClientError);
    expect(() => new OpenCodeV2Client({ baseUrl: 'http://127.0.0.1:49374/prefix' })).toThrow(OpenCodeV2ClientError);
    expect(() => new OpenCodeV2Client({ baseUrl: 'http://127.0.0.1:49374' })).not.toThrow();
  });

  it('listMessages encodes pagination params and returns the cursor pair', async () => {
    const captured: CapturedRequest[] = [];
    const message = {
      id: 'msg_1',
      time: { created: 1760000000000 },
      type: 'user',
      text: 'hello',
    };
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { data: [message], cursor: { previous: null, next: 'cur_next' } }), captured),
    });
    const page = await client.listMessages('ses_1', { limit: 200, order: 'asc', type: 'user' });
    expect(page.data).toEqual([message]);
    expect(page.cursor.next).toBe('cur_next');
    expect(page.cursor.previous).toBeNull();
    const search = new URL(captured[0]!.url).searchParams;
    expect(Object.fromEntries(search)).toEqual({'limit': '200', 'order': 'asc', 'type': 'user'});
  });

  it('listMessages follows the cursor without order and refuses cursor+order together', async () => {
    const captured: CapturedRequest[] = [];
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { data: [], cursor: {} }), captured),
    });
    await client.listMessages('ses_1', { cursor: 'cur_next' });
    expect(Object.fromEntries(new URL(captured[0]!.url).searchParams)).toEqual({'cursor': 'cur_next'});
    await expect(client.listMessages('ses_1', { cursor: 'cur_next', order: 'asc' })).rejects.toMatchObject({
      message: expect.stringContaining('cursor'),
    });
  });

  it('getSessionDiff passes from/to/context and unwraps data', async () => {
    const captured: CapturedRequest[] = [];
    const diff = { file: 'a.ts', patch: '@@ -1 +1 @@', additions: 1, deletions: 1, status: 'modified' };
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => json(200, { data: [diff] }), captured),
    });
    const result = await client.getSessionDiff('ses_1', { from: 'msg_a', to: 'msg_b', context: '3' });
    expect(result).toEqual([diff]);
    const search = new URL(captured[0]!.url).searchParams;
    expect(Object.fromEntries(search)).toEqual({'from': 'msg_a', 'to': 'msg_b', 'context': '3'});
  });

  it('listAllMessages paginates with explicit asc first page and cursor-only follow-ups', async () => {
    const captured: CapturedRequest[] = [];
    const m = (id: string) => ({ id, time: { created: 1 }, type: 'user', text: id });
    const pages = [
      json(200, { data: [m('m1')], cursor: { next: 'c2', previous: null } }),
      json(200, { data: [m('m2')], cursor: { next: 'c3', previous: 'c1' } }),
      json(200, { data: [m('m3')], cursor: { next: null, previous: 'c2' } }),
    ];
    let call = 0;
    const client = new OpenCodeV2Client({
      baseUrl: 'http://127.0.0.1:49374',
      fetch: mockFetch(() => pages[call++]!, captured),
    });
    const messages = await client.listAllMessages('ses_1', { limit: 1, type: 'user' });
    expect(messages.map((msg) => msg.id)).toEqual(['m1', 'm2', 'm3']);
    const queries = captured.map((req) => Object.fromEntries(new URL(req.url).searchParams));
    expect(queries[0]).toEqual({'limit': '1', 'order': 'asc', 'type': 'user'});
    expect(queries[1]).toEqual({'limit': '1', 'type': 'user', 'cursor': 'c2'});
    expect(queries[2]).toEqual({'limit': '1', 'type': 'user', 'cursor': 'c3'});
  });
});

describe('listAllMessages 分页防御（P2）', () => {
  it('拒绝重复 cursor、重复消息 ID、空页带 next、非法 limit', async () => {
    let loopCall = 0;
    const loopFetch = mockFetch(() =>
      json(200, { data: [{ id: `m${++loopCall}`, time: { created: 1 }, type: 'user', text: 'x' }], cursor: { next: 'c_same' } }));
    const loopClient = new OpenCodeV2Client({ baseUrl: 'http://127.0.0.1:49374', fetch: loopFetch });
    await expect(loopClient.listAllMessages('ses_1')).rejects.toThrow(/repeated pagination cursor/);

    const dupFetch = mockFetch(() => json(200, { data: [{ id: 'm1', time: { created: 1 }, type: 'user', text: 'x' }, { id: 'm1', time: { created: 2 }, type: 'user', text: 'y' }], cursor: {} }));
    const dupClient = new OpenCodeV2Client({ baseUrl: 'http://127.0.0.1:49374', fetch: dupFetch });
    await expect(dupClient.listAllMessages('ses_1')).rejects.toThrow(/repeated message id/);

    const emptyFetch = mockFetch(() => json(200, { data: [], cursor: { next: 'c1' } }));
    const emptyClient = new OpenCodeV2Client({ baseUrl: 'http://127.0.0.1:49374', fetch: emptyFetch });
    await expect(emptyClient.listAllMessages('ses_1')).rejects.toThrow(/empty page/);

    const badLimit = new OpenCodeV2Client({ baseUrl: 'http://127.0.0.1:49374', fetch: mockFetch(() => json(200, { data: [], cursor: {} })) });
    await expect(badLimit.listAllMessages('ses_1', { limit: -1 })).rejects.toThrow(/positive integer/);
  });
});
