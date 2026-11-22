# Agent 适配器

## 目标

适配器隔离 OpenCode 和 Codex 的差异，Bridge 核心只依赖统一接口，不直接依赖某个 Agent 的原始协议。

## 统一接口草案

```ts
export interface AgentAdapter {
  readonly id: 'opencode' | 'codex';
  readonly name: string;

  detect(): Promise<AgentDetection>;
  listModels(): Promise<ModelInfo[]>;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  loadSession(sessionId: string): Promise<AgentSession>;
  sendPrompt(input: SendPromptInput): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;
}
```

## OpenCode

OpenCode 是初版的第一适配器，优先使用其结构化 HTTP/SSE 或 SDK 能力：

- 会话列表
- 创建会话
- 加载会话
- 发送消息
- 流式事件
- 模型列表
- 权限事件
- 会话取消

OpenCode 原始事件必须在 Bridge 内部转换，不能直接发送到 Flutter。

## Codex

Codex 是初版的第二适配器，使用 Codex 提供的结构化运行接口。适配器负责：

- 探测 Codex 是否安装和可运行
- 创建或恢复线程
- 发送用户消息
- 读取结构化事件
- 将工具调用、文件变更、文本、思考和错误转换成统一事件
- 处理取消和进程退出

### Codex 会话列表的来源过滤

Bridge 直接读 `~/.codex/state_*.sqlite` 的 `threads` 表来展示历史会话，所以**必须**按 Codex 自己的口径过滤（`codex-rs/core/src/rollout/mod.rs` 的 `INTERACTIVE_SESSION_SOURCES`）：

- 只列 `source` ∈ `cli` / `{"custom":"atlas"}` / `{"custom":"chatgpt"}` / `vscode` 的交互式线程，用精确 `IN` 枚举（不要用 `LIKE '{"custom":%'` 这类前缀匹配，官方 state 层也是 `IN`）；
- 必须排除 `{"subagent": ...}`（子 Agent / thread_spawn / review / compact / guardian 复核线程）、`exec`（`codex exec` 一次性执行线程，包含 Nienie 自己 spawn 的运行）、`mcp`、`{"internal": ...}` 和未知来源；
- 必须排除 `archived = 1`。

否则手机端会冒出 Codex 桌面端根本不存在的「幽灵会话」（典型表现：一堆空标题兜底成 `Codex (项目名)` 的条目）。

代价：Nienie 自己用 `codex exec` 创建的会话在 Codex 侧同样是 `exec` 来源，因此 Bridge 重启后不会从 Codex 历史库恢复；如需跨重启保留，应由 Bridge 自己持久化会话（见 FEATURE.md 的后续计划）。


## 统一能力

适配器必须声明实际能力：

```ts
type AgentCapabilities = {
  streaming: boolean;
  thinking: boolean;
  toolCalls: boolean;
  fileChanges: boolean;
  permissionRequests: boolean;
  modelSwitch: boolean;
  sessionResume: boolean;
  cancel: boolean;
};
```

UI 只能根据能力展示操作，不能假设 OpenCode 和 Codex 完全一致。

## 扩展原则

- 新增 Agent 优先新增适配器，不修改 Bridge 核心。
- 如果多个 Agent 使用同一种协议，复用协议解析器。
- MVP 不实现 ACP 通用适配器，等 OpenCode/Codex 闭环稳定后再加入。后续适配顺序优先考虑 Claude Code、Pi、通用 ACP 和 OpenClaw。
- 未知事件保留为 bounded raw/debug 事件，不允许静默丢弃关键错误。
