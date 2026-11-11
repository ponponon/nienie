import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverOpenCodeService,
  normalizeLocalServiceUrl,
  openCodeRegistrationFiles,
  openCodeServiceAuthHeader,
  openCodeStateDirs,
  readOpenCodeServiceRegistration,
  verifyOpenCodeService,
  type OpenCodeServiceRegistration,
} from '../src/service-discovery.js';

const stateDirs: string[] = [];

function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nienie-svc-'));
  stateDirs.push(dir);
  mkdirSync(join(dir, 'opencode'), { recursive: true });
  return dir;
}

function writeRegistration(stateDir: string, name: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  writeFileSync(join(stateDir, 'opencode', name), text, 'utf8');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const registration: OpenCodeServiceRegistration = {
  id: 'svc_1',
  version: '2.2.5',
  url: 'http://127.0.0.1:49374',
  pid: 28118,
  password: 'secret-password',
};

const serverInfo = { version: '2.2.5', pid: 28118, urls: ['http://127.0.0.1:49374'], paths: { tmp: '/tmp' } };

afterEach(() => {
  while (stateDirs.length > 0) {
    const dir = stateDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('readOpenCodeServiceRegistration', () => {
  it('returns undefined when the file does not exist', () => {
    const dir = makeStateDir();
    expect(readOpenCodeServiceRegistration(join(dir, 'opencode', 'service.json'))).toBeUndefined();
  });

  it('returns undefined for corrupt JSON or missing fields', () => {
    const dir = makeStateDir();
    writeRegistration(dir, 'a.json', '{not json');
    writeRegistration(dir, 'b.json', { version: '2.2.5', pid: 1 });
    writeRegistration(dir, 'c.json', { url: 'http://127.0.0.1:49374', pid: 0 });
    expect(readOpenCodeServiceRegistration(join(dir, 'opencode', 'a.json'))).toBeUndefined();
    expect(readOpenCodeServiceRegistration(join(dir, 'opencode', 'b.json'))).toBeUndefined();
    expect(readOpenCodeServiceRegistration(join(dir, 'opencode', 'c.json'))).toBeUndefined();
  });

  it('parses a valid registration', () => {
    const dir = makeStateDir();
    writeRegistration(dir, 'service.json', registration);
    expect(readOpenCodeServiceRegistration(join(dir, 'opencode', 'service.json'))).toEqual(registration);
  });

  it('rejects the whole registration when optional fields have wrong types', () => {
    const dir = makeStateDir();
    writeRegistration(dir, 'a.json', { url: 'http://127.0.0.1:49374', pid: 1, version: 123 });
    writeRegistration(dir, 'b.json', { url: 'http://127.0.0.1:49374', pid: 1, password: 123 });
    writeRegistration(dir, 'c.json', { url: 'http://127.0.0.1:49374', pid: 1, id: 7 });
    expect(readOpenCodeServiceRegistration(join(dir, 'opencode', 'a.json'))).toBeUndefined();
    expect(readOpenCodeServiceRegistration(join(dir, 'opencode', 'b.json'))).toBeUndefined();
    expect(readOpenCodeServiceRegistration(join(dir, 'opencode', 'c.json'))).toBeUndefined();
  });
});

describe('normalizeLocalServiceUrl', () => {
  it('accepts loopback URLs and rewrites 0.0.0.0 to 127.0.0.1', () => {
    expect(normalizeLocalServiceUrl('http://127.0.0.1:49374')?.toString()).toBe('http://127.0.0.1:49374/');
    expect(normalizeLocalServiceUrl('http://localhost:49374')?.hostname).toBe('localhost');
    expect(normalizeLocalServiceUrl('http://0.0.0.0:49374')?.hostname).toBe('127.0.0.1');
    expect(normalizeLocalServiceUrl('http://[::1]:49374')?.hostname).toBe('[::1]');
  });

  it('rejects malformed, non-http, credential-bearing or non-loopback URLs', () => {
    expect(normalizeLocalServiceUrl('not-a-valid-url')).toBeUndefined();
    expect(normalizeLocalServiceUrl('file:///etc/passwd')).toBeUndefined();
    expect(normalizeLocalServiceUrl('http://user:pass@127.0.0.1:49374')).toBeUndefined();
    expect(normalizeLocalServiceUrl('https://attacker.example')).toBeUndefined();
    expect(normalizeLocalServiceUrl('http://192.168.1.10:49374')).toBeUndefined();
  });

  it('rejects URLs with a path, query or fragment (registration must be a root address)', () => {
    expect(normalizeLocalServiceUrl('http://127.0.0.1:49374/prefix')).toBeUndefined();
    expect(normalizeLocalServiceUrl('http://127.0.0.1:49374?token=abc')).toBeUndefined();
    expect(normalizeLocalServiceUrl('http://127.0.0.1:49374/#fragment')).toBeUndefined();
  });
});

describe('openCodeServiceAuthHeader', () => {
  it('builds a Basic header for the opencode user and never leaks plain credentials', () => {
    const header = openCodeServiceAuthHeader('secret-password');
    expect(header).toEqual({ authorization: `Basic ${Buffer.from('opencode:secret-password').toString('base64')}` });
    expect(header?.['authorization']?.includes('secret-password')).toBe(false);
  });

  it('returns undefined when the registration has no password', () => {
    expect(openCodeServiceAuthHeader(undefined)).toBeUndefined();
  });
});

describe('verifyOpenCodeService', () => {
  it('returns the endpoint when the service answers and identity matches', async () => {
    const calls: { url: string; auth: string | undefined; redirect: RequestRedirect | undefined }[] = [];
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
        redirect: init?.redirect,
      });
      return jsonResponse(200, serverInfo);
    }) as typeof globalThis.fetch;

    const result = await verifyOpenCodeService(registration, { fetch: fetchMock });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.endpoint).toEqual({
      baseUrl: 'http://127.0.0.1:49374',
      version: '2.2.5',
      pid: 28118,
      username: 'opencode',
      password: 'secret-password',
    });
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:49374/api/info',
        auth: `Basic ${Buffer.from('opencode:secret-password').toString('base64')}`,
        redirect: 'error',
      },
    ]);
  });

  it('rejects a pid mismatch', async () => {
    const fetchMock = (async () => jsonResponse(200, { ...serverInfo, pid: 11111 })) as typeof globalThis.fetch;
    const result = await verifyOpenCodeService(registration, { fetch: fetchMock });
    expect(result).toMatchObject({ ok: false, reason: 'identity_mismatch' });
  });

  it('rejects a version mismatch', async () => {
    const fetchMock = (async () => jsonResponse(200, { ...serverInfo, version: '2.2.6' })) as typeof globalThis.fetch;
    const result = await verifyOpenCodeService(registration, { fetch: fetchMock });
    expect(result).toMatchObject({ ok: false, reason: 'version_mismatch' });
  });

  it('rejects wrong credentials and never echoes the password', async () => {
    const fetchMock = (async () => jsonResponse(401, { message: 'Authentication required' })) as typeof globalThis.fetch;
    const result = await verifyOpenCodeService(registration, { fetch: fetchMock });
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' });
    if (result.ok) return;
    expect(result.message.includes('secret-password')).toBe(false);
  });

  it('reports incompatible protocol on a 404 health endpoint', async () => {
    const fetchMock = (async () => jsonResponse(404, {})) as typeof globalThis.fetch;
    const result = await verifyOpenCodeService(registration, { fetch: fetchMock });
    expect(result).toMatchObject({ ok: false, reason: 'incompatible' });
  });

  it('reports incompatible protocol on a non-JSON or malformed info payload', async () => {
    const textFetch = (async () => new Response('<html></html>', { status: 200 })) as typeof globalThis.fetch;
    const badFetch = (async () => jsonResponse(200, { version: 2, pid: 'x' })) as typeof globalThis.fetch;
    expect(await verifyOpenCodeService(registration, { fetch: textFetch })).toMatchObject({ ok: false, reason: 'incompatible' });
    expect(await verifyOpenCodeService(registration, { fetch: badFetch })).toMatchObject({ ok: false, reason: 'incompatible' });
  });

  it('maps failed and not-ready service states', async () => {
    const failedFetch = (async () => jsonResponse(500, { version: '2.2.5', pid: 28118 })) as typeof globalThis.fetch;
    const waitingFetch = (async () => jsonResponse(503, { version: '2.2.5', pid: 28118 })) as typeof globalThis.fetch;
    expect(await verifyOpenCodeService(registration, { fetch: failedFetch })).toMatchObject({ ok: false, reason: 'failed' });
    expect(await verifyOpenCodeService(registration, { fetch: waitingFetch })).toMatchObject({ ok: false, reason: 'not_ready' });
  });

  it('reports unreachable when the fetch fails', async () => {
    const fetchMock = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    const result = await verifyOpenCodeService(registration, { fetch: fetchMock });
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('never fetches a non-local or malformed registration URL', async () => {
    let probed = 0;
    const fetchMock = (async () => {
      probed += 1;
      return jsonResponse(200, serverInfo);
    }) as typeof globalThis.fetch;
    const external = await verifyOpenCodeService({ ...registration, url: 'https://attacker.example' }, { fetch: fetchMock });
    expect(external).toMatchObject({ ok: false, reason: 'invalid_registration' });
    const malformed = await verifyOpenCodeService({ ...registration, url: 'not-a-valid-url' }, { fetch: fetchMock });
    expect(malformed).toMatchObject({ ok: false, reason: 'invalid_registration' });
    expect(probed).toBe(0);
  });

  it('classifies a 503 with an HTML body as incompatible (identity cannot be verified)', async () => {
    const fetchMock = (async () => new Response('<html>starting</html>', { status: 503 })) as typeof globalThis.fetch;
    const result = await verifyOpenCodeService(registration, { fetch: fetchMock });
    expect(result).toMatchObject({ ok: false, reason: 'incompatible' });
  });

  it('classifies a 503 as not_ready only after pid and version identity match', async () => {
    const good = (async () => jsonResponse(503, serverInfo)) as typeof globalThis.fetch;
    const badPid = (async () => jsonResponse(503, { ...serverInfo, pid: 11111 })) as typeof globalThis.fetch;
    expect(await verifyOpenCodeService(registration, { fetch: good })).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(await verifyOpenCodeService(registration, { fetch: badPid })).toMatchObject({ ok: false, reason: 'identity_mismatch' });
  });
});

describe('discoverOpenCodeService', () => {
  it('reports not_found when no registration exists', async () => {
    const dir = makeStateDir();
    const result = await discoverOpenCodeService({ stateDir: dir, fetch: (async () => jsonResponse(200, serverInfo)) as typeof globalThis.fetch });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('reports invalid_registration when the file is corrupt and never probes the network', async () => {
    const dir = makeStateDir();
    writeRegistration(dir, 'service.json', '{not json');
    let probed = 0;
    const result = await discoverOpenCodeService({
      stateDir: dir,
      fetch: (async () => {
        probed += 1;
        return jsonResponse(200, serverInfo);
      }) as typeof globalThis.fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_registration' });
    expect(probed).toBe(0);
  });

  it('falls back to another channel registration when the default one is stale', async () => {
    const dir = makeStateDir();
    writeRegistration(dir, 'service.json', { ...registration, pid: 99999 });
    writeRegistration(dir, 'service-local.json', { ...registration, id: 'svc_local', url: 'http://127.0.0.1:49375' });
    const result = await discoverOpenCodeService({
      stateDir: dir,
      fetch: (async () => jsonResponse(200, { version: '2.2.5', pid: 28118 })) as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registration.id).toBe('svc_local');
  });

  it('returns the first failure when every candidate fails', async () => {
    const dir = makeStateDir();
    writeRegistration(dir, 'service.json', { ...registration, pid: 99999 });
    writeRegistration(dir, 'service-local.json', { ...registration, pid: 88888 });
    const result = await discoverOpenCodeService({
      stateDir: dir,
      fetch: (async () => jsonResponse(200, { version: '2.2.5', pid: 28118 })) as typeof globalThis.fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: 'identity_mismatch' });
    if (result.ok) return;
    expect(result.message.includes('secret-password')).toBe(false);
  });

  it('reports ambiguous when two different live services are registered', async () => {
    const dir = makeStateDir();
    writeRegistration(dir, 'service.json', { ...registration, id: 'svc_a', url: 'http://127.0.0.1:49374', pid: 11111 });
    writeRegistration(dir, 'service-local.json', { ...registration, id: 'svc_b', url: 'http://127.0.0.1:49375', pid: 22222 });
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const pid = url.includes(':49374') ? 11111 : 22222;
      return jsonResponse(200, { version: '2.2.5', pid });
    }) as typeof globalThis.fetch;
    const result = await discoverOpenCodeService({ stateDir: dir, fetch: fetchMock });
    expect(result).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (result.ok) return;
    expect(result.message.includes('secret-password')).toBe(false);
  });

  it('accepts the same instance registered in multiple files', async () => {
    const dir = makeStateDir();
    writeRegistration(dir, 'service.json', registration);
    writeRegistration(dir, 'service-local.json', registration);
    const result = await discoverOpenCodeService({
      stateDir: dir,
      fetch: (async () => jsonResponse(200, serverInfo)) as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registration.id).toBe('svc_1');
    expect(result.endpoint.baseUrl).toBe('http://127.0.0.1:49374');
  });
});

describe('openCodeStateDirs', () => {
  it('prefers XDG_STATE_HOME and always includes the default state root', () => {
    const previous = process.env['XDG_STATE_HOME'];
    process.env['XDG_STATE_HOME'] = '/tmp/xdg-state';
    try {
      const dirs = openCodeStateDirs();
      expect(dirs[0]).toBe('/tmp/xdg-state');
      expect(dirs.some((dir) => dir.endsWith(join('.local', 'state')))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = previous;
    }
  });

  it('returns only the explicit stateDir when provided', () => {
    expect(openCodeStateDirs('/tmp/explicit-state')).toEqual(['/tmp/explicit-state']);
  });

  it('prefers NIENIE_OPENCODE_STATE_DIR over XDG_STATE_HOME', () => {
    const previousXdg = process.env['XDG_STATE_HOME'];
    const previousNieNie = process.env['NIENIE_OPENCODE_STATE_DIR'];
    process.env['XDG_STATE_HOME'] = '/tmp/xdg-state';
    process.env['NIENIE_OPENCODE_STATE_DIR'] = '/tmp/nienie-state';
    try {
      expect(openCodeStateDirs()[0]).toBe('/tmp/nienie-state');
    } finally {
      if (previousXdg === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = previousXdg;
      if (previousNieNie === undefined) delete process.env['NIENIE_OPENCODE_STATE_DIR'];
      else process.env['NIENIE_OPENCODE_STATE_DIR'] = previousNieNie;
    }
  });

  it('probes registrations across every state root', () => {
    const previous = process.env['XDG_STATE_HOME'];
    process.env['XDG_STATE_HOME'] = '/tmp/xdg-state-probe';
    try {
      const files = openCodeRegistrationFiles();
      expect(files).toContain(join('/tmp/xdg-state-probe', 'opencode', 'service.json'));
      expect(files.some((file) => file.endsWith(join('.local', 'state', 'opencode', 'service.json')))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = previous;
    }
  });
});
