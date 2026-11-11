import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type OpenCodeServiceRegistration = {
  id?: string | undefined;
  version?: string | undefined;
  url: string;
  pid: number;
  password?: string | undefined;
};

export type OpenCodeServiceEndpoint = {
  baseUrl: string;
  version: string;
  pid: number;
  username: 'opencode';
  password?: string | undefined;
};

export type OpenCodeServiceDiscoveryReason =
  | 'not_found'
  | 'invalid_registration'
  | 'unreachable'
  | 'unauthorized'
  | 'incompatible'
  | 'identity_mismatch'
  | 'version_mismatch'
  | 'failed'
  | 'not_ready';

export type OpenCodeServiceDiscoveryResult =
  | { ok: true; endpoint: OpenCodeServiceEndpoint; registration: OpenCodeServiceRegistration }
  | { ok: false; reason: OpenCodeServiceDiscoveryReason; message: string };

export type DiscoverOpenCodeServiceOptions = {
  stateDir?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
};

export type VerifyOpenCodeServiceOptions = {
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
};

const DEFAULT_TIMEOUT_MS = 2000;

export function openCodeStateDirs(stateDir?: string): string[] {
  if (stateDir !== undefined) return [stateDir];
  const dirs = new Set<string>();
  const xdg = process.env['XDG_STATE_HOME'];
  if (xdg) dirs.add(xdg);
  dirs.add(join(homedir(), '.local', 'state'));
  return [...dirs];
}

export function openCodeStateDir(stateDir?: string): string {
  return openCodeStateDirs(stateDir)[0] ?? join(homedir(), '.local', 'state');
}

export function openCodeRegistrationFiles(stateDir?: string): string[] {
  const files: string[] = [];
  for (const dir of openCodeStateDirs(stateDir)) {
    const base = join(dir, 'opencode');
    const names = new Set<string>(['service.json', 'service-local.json']);
    try {
      for (const entry of readdirSync(base)) {
        if (/^service-[A-Za-z0-9._-]+\.json$/.test(entry)) names.add(entry);
      }
    } catch {
      // Directory may not exist; candidates still resolve to deterministic paths.
    }
    files.push(
      ...[...names]
        .sort((a, b) => (a === 'service.json' ? -1 : b === 'service.json' ? 1 : a.localeCompare(b)))
        .map((name) => join(base, name)),
    );
  }
  return [...new Set(files)];
}

export function readOpenCodeServiceRegistration(file: string): OpenCodeServiceRegistration | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const url = record['url'];
  const pid = record['pid'];
  if (typeof url !== 'string' || url.length === 0) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  const version = record['version'];
  const id = record['id'];
  const password = record['password'];
  return {
    id: typeof id === 'string' ? id : undefined,
    version: typeof version === 'string' ? version : undefined,
    url,
    pid,
    password: typeof password === 'string' ? password : undefined,
  };
}

export function openCodeServiceAuthHeader(password: string | undefined): Record<string, string> | undefined {
  if (password === undefined) return undefined;
  const token = Buffer.from(`opencode:${password}`, 'utf8').toString('base64');
  return { authorization: `Basic ${token}` };
}

export async function verifyOpenCodeService(
  registration: OpenCodeServiceRegistration,
  options: VerifyOpenCodeServiceOptions = {},
): Promise<OpenCodeServiceDiscoveryResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = new URL('/api/info', registration.url);
  const headers = openCodeServiceAuthHeader(registration.password);
  let response: Response;
  try {
    response = await doFetch(url, {
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'unreachable', message: 'OpenCode service did not respond' };
  }
  if (response.status === 404) {
    return { ok: false, reason: 'incompatible', message: 'OpenCode service health protocol is incompatible' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized', message: 'OpenCode service rejected authentication' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'incompatible', message: 'OpenCode service returned a non-JSON response' };
  }
  const info = decodeServerInfo(body);
  if (info === undefined) {
    return { ok: false, reason: 'incompatible', message: 'OpenCode service returned an invalid info payload' };
  }
  if (info.pid !== registration.pid) {
    return { ok: false, reason: 'identity_mismatch', message: 'OpenCode service process does not match its registration' };
  }
  if (registration.version !== undefined && info.version !== registration.version) {
    return { ok: false, reason: 'version_mismatch', message: 'OpenCode service version does not match its registration' };
  }
  if (response.status === 500) {
    return { ok: false, reason: 'failed', message: 'OpenCode service reported a failed state' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'not_ready', message: 'OpenCode service is not ready yet' };
  }
  return {
    ok: true,
    endpoint: {
      baseUrl: registration.url.replace(/\/+$/, ''),
      version: info.version,
      pid: info.pid,
      username: 'opencode',
      password: registration.password,
    },
    registration,
  };
}

export async function discoverOpenCodeService(
  options: DiscoverOpenCodeServiceOptions = {},
): Promise<OpenCodeServiceDiscoveryResult> {
  const files = openCodeRegistrationFiles(options.stateDir);
  let firstFailure: OpenCodeServiceDiscoveryResult | undefined;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const registration = readOpenCodeServiceRegistration(file);
    if (registration === undefined) {
      const failure: OpenCodeServiceDiscoveryResult = { ok: false, reason: 'invalid_registration', message: `OpenCode service registration is missing or invalid: ${file}` };
      firstFailure ??= failure;
      continue;
    }
    const result = await verifyOpenCodeService(registration, {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) return result;
    firstFailure ??= result;
  }
  return firstFailure ?? { ok: false, reason: 'not_found', message: 'No OpenCode service registration was found' };
}

function decodeServerInfo(input: unknown): { version: string; pid: number } | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const version = record['version'];
  const pid = record['pid'];
  if (typeof version !== 'string') return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 0) return undefined;
  return { version, pid };
}
