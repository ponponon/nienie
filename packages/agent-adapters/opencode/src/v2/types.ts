export type OpenCodeV2ModelRef = {
  id: string;
  providerID: string;
  variant?: string | undefined;
};

export type OpenCodeV2LocationRef = {
  directory: string;
};

export type OpenCodeV2TokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type OpenCodeV2SessionInfo = {
  id: string;
  parentID?: string | undefined;
  fork?: { sessionID: string; boundary: unknown } | undefined;
  projectID: string;
  agent?: string | undefined;
  model?: OpenCodeV2ModelRef | undefined;
  cost: number;
  tokens: OpenCodeV2TokenUsage;
  outcome?: 'succeeded' | 'failed' | 'interrupted' | undefined;
  time: {
    created: number;
    updated: number;
    busy?: number | undefined;
    idle?: number | undefined;
    viewed?: number | undefined;
    archived?: number | undefined;
  };
  title?: string | undefined;
  location: OpenCodeV2LocationRef;
  subpath?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  permissions?: unknown;
  revert?: unknown;
};

export type OpenCodeV2SessionListQuery = {
  limit?: number | undefined;
  order?: 'asc' | 'desc' | undefined;
  search?: string | undefined;
  parentID?: string | undefined;
  archived?: boolean | undefined;
  directory?: string | undefined;
  project?: string | undefined;
  subpath?: string | undefined;
  cursor?: string | undefined;
};

export type OpenCodeV2SessionListResponse = {
  data: OpenCodeV2SessionInfo[];
  cursor: { previous?: string | undefined; next?: string | undefined };
};

export type OpenCodeV2CreateSessionInput = {
  id?: string | undefined;
  parentID?: string | undefined;
  title?: string | undefined;
  agent?: string | undefined;
  model?: OpenCodeV2ModelRef | undefined;
  location?: OpenCodeV2LocationRef | undefined;
  metadata?: Record<string, unknown> | undefined;
  permissions?: unknown;
};

export type OpenCodeV2ModelInfo = {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  canonical?: boolean | undefined;
  type?: string | undefined;
  family?: string | undefined;
  capabilities: {
    tools: boolean;
    input: string[];
    output: string[];
    temperature?: boolean | undefined;
  };
  variants: Array<{
    id: string;
    settings?: Record<string, unknown> | undefined;
    headers?: Record<string, string> | undefined;
    body?: Record<string, unknown> | undefined;
  }>;
  time: { released: number };
  cost: Array<{
    tier?: string | undefined;
    input: number;
    output: number;
    cache: { read: number; write: number };
  }>;
  status: 'alpha' | 'beta' | 'deprecated' | 'active';
  enabled: boolean;
  limit: { context: number; input?: number | undefined; output: number };
};

export type OpenCodeV2ProviderInfo = {
  id: string;
  name: string;
  activation: 'auto' | 'enabled' | 'disabled';
  package: string;
  canonical?: boolean | undefined;
  integrationID?: string | undefined;
  compatibility?: unknown;
  settings?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  body?: Record<string, unknown> | undefined;
};

export type OpenCodeV2ServerInfo = {
  version: string;
  pid: number;
  hostname?: string | undefined;
  urls: string[];
  paths: { tmp: string };
  capabilities?: { persistentPty?: boolean | undefined } | undefined;
};

export type OpenCodeV2PromptMention = {
  start: number;
  end: number;
  text: string;
};

export type OpenCodeV2PromptFileAttachment = {
  uri: string;
  source?: { type: 'inline' } | { type: 'uri'; uri: string } | undefined;
  name?: string | undefined;
  description?: string | undefined;
  mention?: OpenCodeV2PromptMention | undefined;
};

export type OpenCodeV2PromptAgentAttachment = {
  name: string;
  mention?: OpenCodeV2PromptMention | undefined;
};

export type OpenCodeV2PromptSkillAttachment = {
  id: string;
  mention?: OpenCodeV2PromptMention | undefined;
};

export type OpenCodeV2PromptInput = {
  text: string;
  id?: string | undefined;
  files?: OpenCodeV2PromptFileAttachment[] | undefined;
  agents?: OpenCodeV2PromptAgentAttachment[] | undefined;
  skills?: OpenCodeV2PromptSkillAttachment[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  delivery?: 'steer' | 'queue' | undefined;
  resume?: boolean | undefined;
};

export type OpenCodeV2InboxUserMessage = {
  id: string;
  sessionID: string;
  time: { created: number };
  type: 'user';
  payload: {
    text: string;
    files?: unknown;
    agents?: unknown;
    skills?: unknown;
    metadata?: Record<string, unknown> | undefined;
  };
  delivery: string;
};

export type OpenCodeV2PermissionDecision = 'once' | 'always' | 'reject';

export type OpenCodeV2ModelListQuery = {
  directory?: string | undefined;
  types?: string | string[] | undefined;
};

export type OpenCodeV2LocationResponse<T> = {
  location: OpenCodeV2LocationRef;
  data: T;
};
