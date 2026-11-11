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

export type OpenCodeV2ForkBoundary =
  | { type: 'before'; messageID: string }
  | { type: 'through'; messageID: string };

export type OpenCodeV2PermissionRule = {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
};

export type OpenCodeV2FileDiffInfo = {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
  more?: true | undefined;
};

export type OpenCodeV2SessionRevert = {
  messageID: string;
  partID?: string | undefined;
  snapshot?: string | undefined;
  files?: OpenCodeV2FileDiffInfo[] | undefined;
};

export type OpenCodeV2SessionInfo = {
  id: string;
  parentID?: string | undefined;
  fork?: { sessionID: string; boundary: OpenCodeV2ForkBoundary } | undefined;
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
  permissions?: OpenCodeV2PermissionRule[] | undefined;
  revert?: OpenCodeV2SessionRevert | undefined;
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
  cursor: { previous?: string | null | undefined; next?: string | null | undefined };
};

export type OpenCodeV2CreateSessionInput = {
  id?: string | undefined;
  parentID?: string | undefined;
  title?: string | undefined;
  agent?: string | undefined;
  model?: OpenCodeV2ModelRef | undefined;
  location?: OpenCodeV2LocationRef | undefined;
  metadata?: Record<string, unknown> | undefined;
  permissions?: OpenCodeV2PermissionRule[] | undefined;
};

export type OpenCodeV2ProviderCompatibility = {
  reasoningField?: string | undefined;
  requireReasoning?: boolean | undefined;
  maxTokensField?: 'max_completion_tokens' | 'max_tokens' | undefined;
  requireFinishReason?: boolean | undefined;
  requireAssistantAfterTool?: boolean | undefined;
  supportsPromptCacheKey?: boolean | undefined;
  streamUsage?: boolean | undefined;
  cacheFormat?: 'anthropic' | 'alibaba' | undefined;
  mediaInput?: 'assets' | 'state' | 'root' | undefined;
};

export type OpenCodeV2ModelCompatibility = OpenCodeV2ProviderCompatibility & {
  supportsThinkingBlockBinding?: boolean | undefined;
  supportsEffortUpdates?: boolean | undefined;
};

export type OpenCodeV2ModelCostTier = {
  type: 'context';
  size: number;
};

export type OpenCodeV2ModelCost = {
  tier?: OpenCodeV2ModelCostTier | undefined;
  input: number;
  output: number;
  cache: { read: number; write: number };
};

export type OpenCodeV2ModelCapabilities = {
  tools: boolean;
  input: string[];
  output: string[];
  temperature?: boolean | undefined;
};

export type OpenCodeV2ModelVariant = {
  id: string;
  settings?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  body?: Record<string, unknown> | undefined;
};

export type OpenCodeV2ModelInfo = {
  id: string;
  modelID: string;
  providerID: string;
  canonical?: string | undefined;
  type?: string | undefined;
  family?: string | undefined;
  name: string;
  compatibility?: OpenCodeV2ModelCompatibility | undefined;
  package?: string | undefined;
  settings?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  body?: Record<string, unknown> | undefined;
  capabilities: OpenCodeV2ModelCapabilities;
  variants: OpenCodeV2ModelVariant[];
  time: { released: number };
  cost: OpenCodeV2ModelCost[];
  status: 'alpha' | 'beta' | 'deprecated' | 'active';
  enabled: boolean;
  limit: { context: number; input?: number | undefined; output: number };
};

export type OpenCodeV2ProviderInfo = {
  id: string;
  name: string;
  activation: 'auto' | 'enabled' | 'disabled';
  package: string;
  canonical?: string | undefined;
  integrationID?: string | undefined;
  compatibility?: OpenCodeV2ProviderCompatibility | undefined;
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

export type OpenCodeV2PromptFileSource = { type: 'inline' } | { type: 'uri'; uri: string };

export type OpenCodeV2PromptFileAttachment = {
  uri: string;
  source?: OpenCodeV2PromptFileSource | undefined;
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

export type OpenCodeV2InboxFileAttachment = {
  data: string;
  mime: string;
  source: OpenCodeV2PromptFileSource;
  name?: string | undefined;
  description?: string | undefined;
  mention?: OpenCodeV2PromptMention | undefined;
};

export type OpenCodeV2InboxAgentAttachment = {
  name: string;
  mention?: OpenCodeV2PromptMention | undefined;
};

export type OpenCodeV2InboxSkillAttachment = {
  id: string;
  name: string;
  text?: string | undefined;
  mention?: OpenCodeV2PromptMention | undefined;
};

export type OpenCodeV2InboxUserMessage = {
  id: string;
  sessionID: string;
  time: { created: number };
  type: 'user';
  payload: {
    text: string;
    files?: OpenCodeV2InboxFileAttachment[] | undefined;
    agents?: OpenCodeV2InboxAgentAttachment[] | undefined;
    skills?: OpenCodeV2InboxSkillAttachment[] | undefined;
    metadata?: Record<string, unknown> | undefined;
  };
  delivery: 'steer' | 'queue';
};

export type OpenCodeV2PermissionDecision = 'once' | 'always' | 'reject';

export type OpenCodeV2LocationQuery = {
  directory?: string | undefined;
};

export type OpenCodeV2ModelListQuery = OpenCodeV2LocationQuery & {
  types?: string | string[] | undefined;
};

export type OpenCodeV2LocationResponse<T> = {
  location: OpenCodeV2LocationRef;
  data: T;
};

export type OpenCodeV2ToolTextContent = { type: 'text'; text: string };

export type OpenCodeV2ToolFileContent = {
  type: 'file';
  uri: string;
  mime: string;
  name?: string | null | undefined;
};

export type OpenCodeV2ToolContent = OpenCodeV2ToolTextContent | OpenCodeV2ToolFileContent;

export type OpenCodeV2StructuredError = {
  type: string;
  message: string;
  status?: number | undefined;
  response?: { body: string } | undefined;
  retryAfterMs?: number | undefined;
};

export type OpenCodeV2ToolState =
  | { status: 'streaming'; input: string }
  | { status: 'running'; input: Record<string, unknown>; metadata?: Record<string, unknown> | undefined }
  | {
      status: 'completed';
      input: Record<string, unknown>;
      content: OpenCodeV2ToolContent[];
      metadata?: Record<string, unknown> | undefined;
    }
  | {
      status: 'error';
      input: Record<string, unknown>;
      error: OpenCodeV2StructuredError;
      content?: OpenCodeV2ToolContent[] | undefined;
      metadata?: Record<string, unknown> | undefined;
    };

export type OpenCodeV2AssistantTextPart = { type: 'text'; text: string; native?: unknown };

export type OpenCodeV2AssistantReasoningPart = {
  type: 'reasoning';
  text: string;
  native?: unknown;
  time?: { created: number; completed?: number | undefined } | undefined;
};

export type OpenCodeV2AssistantToolPart = {
  type: 'tool';
  id: string;
  name: string;
  executed?: boolean | undefined;
  native?: unknown;
  state: OpenCodeV2ToolState;
  time: { created: number; ran?: number | undefined; completed?: number | undefined };
};

export type OpenCodeV2AssistantContentPart =
  | OpenCodeV2AssistantTextPart
  | OpenCodeV2AssistantReasoningPart
  | OpenCodeV2AssistantToolPart;

export type OpenCodeV2UserMessage = {
  id: string;
  time: { created: number };
  type: 'user';
  text: string;
  files?: OpenCodeV2InboxFileAttachment[] | undefined;
  agents?: OpenCodeV2InboxAgentAttachment[] | undefined;
  skills?: OpenCodeV2InboxSkillAttachment[] | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type OpenCodeV2AssistantMessage = {
  id: string;
  time: { created: number; streamed?: number | undefined; completed?: number | undefined };
  type: 'assistant';
  agent?: string | undefined;
  model?: OpenCodeV2ModelRef | undefined;
  content: OpenCodeV2AssistantContentPart[];
  metadata?: Record<string, unknown> | undefined;
};

export type OpenCodeV2SystemMessageType =
  | 'agent-switched'
  | 'model-switched'
  | 'location-switched'
  | 'synthetic'
  | 'system'
  | 'skill'
  | 'shell'
  | 'compaction'
  | 'idle';

export type OpenCodeV2OtherMessage = {
  id: string;
  time: { created: number };
  type: OpenCodeV2SystemMessageType;
  metadata?: Record<string, unknown> | undefined;
};

export type OpenCodeV2SessionMessageInfo =
  | OpenCodeV2UserMessage
  | OpenCodeV2AssistantMessage
  | OpenCodeV2OtherMessage;

export type OpenCodeV2MessageListQuery = {
  limit?: number | undefined;
  order?: 'asc' | 'desc' | undefined;
  cursor?: string | undefined;
  type?: OpenCodeV2SystemMessageType | 'assistant' | 'user' | undefined;
};

export type OpenCodeV2MessageListResponse = {
  data: OpenCodeV2SessionMessageInfo[];
  cursor: { previous?: string | null | undefined; next?: string | null | undefined };
};

export type OpenCodeV2DiffQuery = {
  from?: string | undefined;
  to?: string | undefined;
  context?: string | undefined;
};
