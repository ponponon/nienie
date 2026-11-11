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
  | 'not_ready'
  | 'ambiguous';

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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

export function openCodeStateDirs(stateDir?: string): string[] {
  if (stateDir !== undefined) return [stateDir];
  const dirs = new Set<string>();
  const explicit = process.env['NIENIE_OPENCODE_STATE_DIR'];
  if (explicit) dirs.add(explicit);
  const xdg = process.env['XDG_STATE_HOME'];
  if (xdg) dirs.add(xdg);
  dirs.add(join(homedir(), '.local', 'state'));
  return [...dirs];
}

export function openCodeStateDir(stateDir?: string): string {
  return openCodeStateDirs(stateDir)[0] ?? join(homedir(), '.local', 'state');
}

function registrationNamePriority(name: string): number {
  if (name === 'service.json') return 0;
  if (name === 'service-local.json') return 1;
  return 2;
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
        .sort((a, b) => {
          const pa = registrationNamePriority(a);
          const pb = registrationNamePriority(b);
          return pa !== pb ? pa - pb : a.localeCompare(b);
        })
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
  if ('version' in record && typeof record['version'] !== 'string') return undefined;
  if ('password' in record && typeof record['password'] !== 'string') return undefined;
  if ('id' in record && typeof record['id'] !== 'string') return undefined;
  return {
    id: typeof record['id'] === 'string' ? record['id'] : undefined,
    version: typeof record['version'] === 'string' ? record['version'] : undefined,
    url,
    pid,
    password: typeof record['password'] === 'string' ? record['password'] : undefined,
  };
}

export function normalizeLocalServiceUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url;
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
  const url = normalizeLocalServiceUrl(registration.url);
  if (url === undefined) {
    return { ok: false, reason: 'invalid_registration', message: 'OpenCode service registration has an invalid or non-local URL' };
  }
  const headers = openCodeServiceAuthHeader(registration.password);
  let response: Response;
  try {
    response = await doFetch(new URL('/api/info', url), {
      ...(headers ? { headers } : {}),
      redirect: 'error',
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
  if (response.status === 503) {
    return { ok: false, reason: 'not_ready', message: 'OpenCode service is starting' };
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
      baseUrl: url.toString().replace(/\/+$/, ''),
      version: info.version,
      pid: info.pid,
      username: 'opencode',
      password: registration.password,
    },
    registration,
  };
}

function sameServiceInstance(
  left: OpenCodeServiceRegistration,
  right: OpenCodeServiceRegistration,
): boolean {
  return left.id === right.id && left.version === right.version && left.url === right.url && left.pid === right.pid;
}

export async function discoverOpenCodeService(
  options: DiscoverOpenCodeServiceOptions = {},
): Promise<OpenCodeServiceDiscoveryResult> {
  const files = openCodeRegistrationFiles(options.stateDir);
  const valid: Extract<OpenCodeServiceDiscoveryResult, { ok: true }>[] = [];
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
    if (result.ok) valid.push(result);
    else firstFailure ??= result;
  }
  if (valid.length === 0) {
    return firstFailure ?? { ok: false, reason: 'not_found', message: 'No OpenCode service registration was found' };
  }
  const first = valid[0]!;
  const allSame = valid.every((candidate) => sameServiceInstance(candidate.registration, first.registration));
  if (!allSame) {
    return { ok: false, reason: 'ambiguous', message: 'Multiple OpenCode services are registered; pass a stateDir to select one' };
  }
  return first;
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
