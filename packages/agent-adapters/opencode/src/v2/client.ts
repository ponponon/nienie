import { openCodeServiceAuthHeader } from '../service-discovery.js';
import type {
  OpenCodeV2CreateSessionInput,
  OpenCodeV2InboxUserMessage,
  OpenCodeV2LocationResponse,
  OpenCodeV2ModelInfo,
  OpenCodeV2ModelListQuery,
  OpenCodeV2ModelRef,
  OpenCodeV2PermissionDecision,
  OpenCodeV2PromptInput,
  OpenCodeV2ProviderInfo,
  OpenCodeV2ServerInfo,
  OpenCodeV2SessionInfo,
  OpenCodeV2SessionListQuery,
  OpenCodeV2SessionListResponse,
} from './types.js';

export class OpenCodeV2ClientError extends Error {
  readonly status: number;
  readonly tag: string | undefined;

  constructor(message: string, status: number, tag?: string | undefined) {
    super(message);
    this.name = 'OpenCodeV2ClientError';
    this.status = status;
    this.tag = tag;
  }
}

export type OpenCodeV2ClientOptions = {
  baseUrl: string;
  password?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
};

const DEFAULT_TIMEOUT_MS = 15000;

export class OpenCodeV2Client {
  private readonly baseUrl: string;
  private readonly password: string | undefined;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenCodeV2ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.password = options.password;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getServerInfo(): Promise<OpenCodeV2ServerInfo> {
    return this.request<OpenCodeV2ServerInfo>('GET', '/api/info');
  }

  async listSessions(query: OpenCodeV2SessionListQuery = {}): Promise<OpenCodeV2SessionListResponse> {
    return this.request<OpenCodeV2SessionListResponse>('GET', '/api/session', { query: sessionListQuery(query) });
  }

  async createSession(input: OpenCodeV2CreateSessionInput = {}): Promise<OpenCodeV2SessionInfo> {
    const response = await this.request<{ data: OpenCodeV2SessionInfo }>('POST', '/api/session', { body: input });
    return response.data;
  }

  async getSession(sessionId: string): Promise<OpenCodeV2SessionInfo> {
    const response = await this.request<{ data: OpenCodeV2SessionInfo }>('GET', sessionPath(sessionId));
    return response.data;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>('DELETE', sessionPath(sessionId));
  }

  async listModels(query: OpenCodeV2ModelListQuery = {}): Promise<OpenCodeV2LocationResponse<OpenCodeV2ModelInfo[]>> {
    return this.request<OpenCodeV2LocationResponse<OpenCodeV2ModelInfo[]>>('GET', '/api/model', {
      query: modelQuery(query),
    });
  }

  async getDefaultModel(
    query: OpenCodeV2ModelListQuery = {},
  ): Promise<OpenCodeV2LocationResponse<OpenCodeV2ModelInfo | null>> {
    return this.request<OpenCodeV2LocationResponse<OpenCodeV2ModelInfo | null>>('GET', '/api/model/default', {
      query: modelQuery(query),
    });
  }

  async listProviders(
    query: OpenCodeV2ModelListQuery = {},
  ): Promise<OpenCodeV2LocationResponse<OpenCodeV2ProviderInfo[]>> {
    return this.request<OpenCodeV2LocationResponse<OpenCodeV2ProviderInfo[]>>('GET', '/api/provider', {
      query: modelQuery(query),
    });
  }

  async switchModel(sessionId: string, model: OpenCodeV2ModelRef): Promise<void> {
    await this.request<void>('POST', `${sessionPath(sessionId)}/model`, { body: { model } });
  }

  async prompt(sessionId: string, input: OpenCodeV2PromptInput): Promise<OpenCodeV2InboxUserMessage> {
    const response = await this.request<{ data: OpenCodeV2InboxUserMessage }>('POST', `${sessionPath(sessionId)}/prompt`, {
      body: input,
    });
    return response.data;
  }

  async interrupt(sessionId: string, options: { resume?: boolean | undefined } = {}): Promise<{ interrupted: boolean }> {
    const query: Record<string, string> = {};
    if (options.resume !== undefined) query['resume'] = String(options.resume);
    return this.request<{ interrupted: boolean }>('POST', `${sessionPath(sessionId)}/interrupt`, { query });
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: OpenCodeV2PermissionDecision,
    message?: string | undefined,
  ): Promise<void> {
    await this.request<void>(
      'POST',
      `${sessionPath(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { body: message === undefined ? { decision } : { decision, message } },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string | string[]> | undefined; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, item);
        } else {
          url.searchParams.set(key, value);
        }
      }
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    const auth = openCodeServiceAuthHeader(this.password);
    if (auth) Object.assign(headers, auth);
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new OpenCodeV2ClientError(
        error instanceof Error ? error.message : 'OpenCode service request failed',
        0,
      );
    }
    if (!response.ok) {
      throw await toClientError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (text.length === 0) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }
}

function sessionPath(sessionId: string): string {
  return `/api/session/${encodeURIComponent(sessionId)}`;
}

function sessionListQuery(query: OpenCodeV2SessionListQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (query.limit !== undefined) out['limit'] = String(query.limit);
  if (query.order !== undefined) out['order'] = query.order;
  if (query.search !== undefined) out['search'] = query.search;
  if (query.parentID !== undefined) out['parentID'] = query.parentID;
  if (query.archived !== undefined) out['archived'] = String(query.archived);
  if (query.directory !== undefined) out['directory'] = query.directory;
  if (query.project !== undefined) out['project'] = query.project;
  if (query.subpath !== undefined) out['subpath'] = query.subpath;
  if (query.cursor !== undefined) out['cursor'] = query.cursor;
  return out;
}

function modelQuery(query: OpenCodeV2ModelListQuery): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (query.directory !== undefined) out['location[directory]'] = query.directory;
  if (query.types !== undefined) out['types'] = Array.isArray(query.types) ? query.types : [query.types];
  return out;
}

async function toClientError(response: Response): Promise<OpenCodeV2ClientError> {
  let message = `OpenCode service request failed with status ${response.status}`;
  let tag: string | undefined;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body['message'] === 'string') message = body['message'];
    if (typeof body['_tag'] === 'string') tag = body['_tag'];
  } catch {
    // Non-JSON error bodies keep the status-based message.
  }
  return new OpenCodeV2ClientError(message, response.status, tag);
}
