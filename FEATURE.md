# 功能记录

本文档记录 Nienie 已实现和规划中的产品功能，确保未来更换开发者或 AI 后，可以从零理解并重建项目。

## 已完成

### 2026-11-03 项目初始化

- 确定产品名称：Nienie / 捏捏
- 确定产品定位：移动优先的本地 AI 编程 Agent 控制台
- 确定手机端使用 Flutter，目标为 iOS 和 Android
- 确定电脑端使用 Electron + React + TypeScript
- 确定 Bridge 使用 Node.js + TypeScript，并先嵌入 Electron 主进程
- 确定初版 Agent 范围为 OpenCode 和 Codex
- 确定后续扩展路线包含 Claude Code、Pi、OpenClaw、ACP Agent 和其他本地 Agent
- 建立统一事件协议和适配器架构文档
- 建立 TypeScript workspace、统一协议包和 Bridge 核心骨架
- 建立 OpenCode/Codex 适配器接口和 Electron 组合入口
- 增加可替换公网 Relay 默认配置：`wss://nienie-replay.quniv.cn`

### 2026-11-04 实现真实 OpenCode 适配器与事件归一化闭环

- 实现 `@nienie/adapter-opencode` 真实 HTTP/SSE 传输层：
  - `detect()`：连接 `/global/health` 检测服务可用性与版本号
  - `listSessions()`：拉取 `/session` 并合并 `/session/status` 状态映射为统一 `AgentSession`
  - `createSession()`：调用 `POST /session` 创建会话并支持工作目录参数
  - `loadSession()`：调用 `GET /session/:id` 恢复会话并校验会话真实存在，拒绝伪造已丢失会话状态
  - `sendMessage()`：调用 `POST /session/:id/prompt_async` 发送结构化文本消息并自动维护 SSE 订阅
  - `cancel()`：调用 `POST /session/:id/abort` 取消正在执行的会话
  - `connectEvents()` & `parseSseStream()`：解析 `/event` SSE 流（支持分块帧、注释忽略、CRLF 兼容）
- 实现 `OpenCodeEventNormalizer`：
  - 将 OpenCode v1/v2 事件（`session.status`、`session.idle`、`message.part.delta`、`message.part.updated`、`permission.asked`、`step-finish`、`session.error`、`session.next.*`）转换为 Nienie `CanonicalAgentEvent`
  - 过滤用户自身消息文本，防止误发为 assistant `text_delta`
  - 对 `message.part.delta` 与 `message.part.updated` 快照做增量去重
  - 确保 `tool_use` 与 `tool_result` 严格按 `toolCallId` 成对关联
  - 支持敏感凭据字段自动脱敏（`[REDACTED]`）与超长工具输出截断
- 在 `@nienie/bridge-core` 的 `AgentRegistry` 与 `SessionRouter` 中打通 `OpenCode → Bridge → 统一事件` 闭环，支持会话创建、恢复和跨适配器统一事件订阅

### 2026-11-04 实现本地 Bridge WebSocket 服务

- 在 `@nienie/protocol` 中实现 `parseBridgeRequest()` 消息校验（校验 JSON 格式、消息字节上限 `DEFAULT_MAX_MESSAGE_BYTES`、`protocolVersion` 与请求结构）
- 在 `@nienie/bridge-core` 中实现基于 RFC 6455 的零依赖本地 `BridgeServer`：
  - 默认监听 `127.0.0.1` 并暴露 `GET /health` 健康检查接口
  - 支持 `hello`、`ping`、`agents.list`、`sessions.list`、`session.create`、`session.load`、`session.send`、`session.cancel` 命令路由
  - 自动订阅 `AgentRegistry` 事件并向已连接客户端实时广播 `session.event`（`CanonicalAgentEvent`）
  - 内置 WebSocket Ping/Pong 心跳巡检、超大帧拦截（1009）与客户端断线自动清理
- 在 `@nienie/desktop` 中提供 `createDesktopBridgeServer()` 组合入口

### 2026-11-04 实现本地配对与设备鉴权机制

- 在 `@nienie/protocol` 中实现 `PairingQrPayload`、`encodePairingQrPayload()` / `decodePairingQrPayload()`（`nienie://pair?data=...` URI 编解码）及 `pair.confirm` 请求校验
- 在 `@nienie/bridge-core` 中实现 `PairingManager`：
  - 生成带过期时间（TTL）的 6 位一次性配对码与二维码 URI（二维码不暴漏长期密钥）
  - 手机完成 `pair.confirm` 后配对码立即作废，签发独立 `deviceId` 与高熵 `deviceToken`（服务端仅存储 SHA-256 哈希）
  - 支持重连时通过 `hello` 携带 `deviceToken` 恢复设备鉴权
  - 支持 `revokeDevice()` 单独撤销设备凭据，并在 `BridgeServer` 中实时吊销活跃连接权限与事件广播订阅
  - 未授权设备发起 `agents.list`、`sessions.list`、`session.create`、`session.load`、`session.send`、`session.cancel` 请求一律拦截并返回 `UNAUTHORIZED`

### 2026-11-04 实现 Electron 桌面端最小 UI 与主进程控制器

- 在 `@nienie/desktop` 中实现 `DesktopBridgeController` 与 `registerDesktopIpcHandlers()`：
  - 通过 IPC 管理本地 Bridge 启动/停止与状态快照
  - 探测并展示本机 OpenCode 与 Codex Agent 可用性、版本号与能力标签
  - 生成一次性配对码与内联 SVG 二维码（`renderPairingQrSvg`）
  - 支持在默认公网 Relay（`wss://nienie-replay.quniv.cn`）与用户自定义 Relay 地址之间切换并同步更新配对载荷
  - 聚合 Bridge 生命周期日志与脱敏后的会话事件诊断日志
- 实现 `renderDesktopAppHtml()` 与 `createDesktopWindowOptions()`：
  - 采用深色 Design System CSS Tokens、原生 macOS 窗口 `trafficLightPosition` 留白（`padding-left: 78px`）、CSP 安全策略与纯内联 SVG 图标（零 Emoji）

### 2026-11-04 实现 Flutter 手机端最小 UI 与统一协议客户端

- 在 `apps/mobile` 中实现 Flutter 手机端核心模块（`lib/main.dart`）：
  - `PairingQrPayload.decode`：解析 `nienie://pair?data=...` 配对二维码 URI
  - `DeviceCredentialStore` & `InMemoryCredentialStore`：保存手机侧获得的 `deviceId` 与 `deviceToken`（不保存电脑端 Agent 凭据）
  - `MobileBridgeClient` & `IoBridgeTransport`：基于 WebSocket 实现一次性配对码绑定（`pair.confirm`）、令牌重连（`hello`）、拉取 Agent 列表（`agents.list`）、拉取/创建/恢复会话（`sessions.list`、`session.create`、`session.load`）、发送消息（`session.send`）
  - 统一事件流归并：按每个会话的 `sequence` 排序与去重，将 `text_delta`、`thinking_delta`、`tool_use` + `tool_result`（按 `toolCallId` 成对关联）、`error` 实时映射为结构化时间线卡片
  - `NienieMobileApp`：深色 Material 3 移动端界面，包含配对连接面板、Agent 状态栏、Session 切换栏、独立视觉形态的流式文本/工具调用/错误卡片与底部 Prompt 输入栏（通过 `flutter test` 与 `flutter analyze` 验证）

### 2026-11-04 打通第一个端到端闭环（Mobile → Desktop Bridge → OpenCode → 手机实时渲染）

- 新增桌面端全链路闭环测试 `apps/desktop/tests/e2e-loop.test.ts` 与移动端真机 WebSocket 集成测试 `apps/mobile/test/e2e_real_ws_test.dart`
- 完整覆盖并通过 `AGENTS.md` 核心验证项：
  - Bridge 启动并发现 OpenCode/Codex
  - 手机通过一次性配对码/二维码 URI 完成绑定
  - WebSocket 建立连接及断线后凭 `deviceToken` 恢复认证连接
  - 流式文本分片接收与 `idle` 状态收尾
  - `tool_use` 与 `tool_result` 按 `toolCallId` 成对关联
  - Bridge 重启后对已消失的旧会话严格报错，拒绝伪造旧会话状态
  - 未授权设备发送 Prompt 请求被 `UNAUTHORIZED` 拦截

### 2026-11-04 实现 Codex 适配器 (`@nienie/adapter-codex`)

- 实现 `CodexAdapter` 真实 CLI 探测与 JSONL 结构化运行接口：
  - `detect()`：执行 `codex --version` 解析版本号（支持 `NIENIE_CODEX_BIN` 命名空间环境变量）
  - `createSession()` / `loadSession()` / `listSessions()`：创建新线程并在收到 `thread.started` 后自动绑定 `thread_id`，后续消息自动切换为 `codex exec resume --json <thread_id>`
  - `sendMessage()` / `cancel()`：启动 `codex exec --json` 子进程并流式消费 stdout JSONL，取消时发送信号终止运行进程
- 实现 `CodexEventNormalizer`：
  - 将 Codex 的 `turn.started`、`reasoning`、`agent_message`、`command_execution`、`file_change`、`mcp_tool_call`、`turn.completed`、`turn.failed` 统一转换为 Nienie `CanonicalAgentEvent`

### 2026-11-04 实现公网 Relay 服务与出站加密路由 (`@nienie/protocol` & `@nienie/bridge-core`)

- 在 `@nienie/protocol` 中实现 `encryptRelayPayload()` / `decryptRelayPayload()`（基于 `AES-256-GCM` 的端到端消息加密与防篡改校验）及 `RelayWireMessage` 路由信封
- 在 `@nienie/bridge-core` 中实现 `RelayServer` 与 `BridgeRelayClient`：
  - 支持 Bridge 出站连接与手机出站连接（`relay.register`）
  - 按 `machineId` 与 `clientId` 进行双向消息路由（Relay 仅读取路由元数据，不解析密文载荷）
  - 实时推送 `relay.presence` 在线/离线状态变更
  - 默认使用 `wss://nienie-replay.quniv.cn`，支持用户替换为自定义 Relay 地址
  - 支持 Bridge 断线自动重连并恢复在线状态

### 2026-11-04 补齐安全与可靠性（事件序号补发、状态快照、权限审批、日志脱敏、多机器管理）

- 事件序号缓存与补发（`events.replay`）：`BridgeServer` 按会话维护环形事件缓存，手机重连后可按 `afterSequence` 拉取断线期间缺失的流式事件
- 机器与会话状态快照（`machine.get` & `session.state`）：返回真实机器与会话状态、最新 `sequence` 与缓存深度，Bridge 重启后拒绝伪造不存在的旧会话状态
- 权限审批闭环（`permission.reply`）：对接 OpenCode `POST /session/:id/permissions/:permissionID`（支持 `allow_once`、`allow_always`、`reject`），并在 `BridgeServer` 中严格拦截未授权设备的审批请求
- 日志脱敏（`redactLogText`）：自动脱敏诊断日志中的 `ntk_*` 设备令牌、`sk-*` API Key、`Bearer`/`Basic` 标头与密码键值
- 多机器管理：移动端 `DeviceCredentialStore` 支持存储、列出、按 `machineId` 切换与移除多台已配对电脑
- 模型发现与切换（`models.list`）：`OpenCodeAdapter.listModels()` 对接 `GET /config/providers` 提取可用模型与默认模型，`BridgeServer` 暴露 `models.list` 命令并支持在 `session.send` 中指定 `modelId`
- 会话文件变更与 Diff 查询（`session.diff`）：`OpenCodeAdapter.getSessionDiff()` 对接 `GET /session/:id/diff` 获取文件级增删行数与前后内容，`BridgeServer` 暴露 `session.diff` 命令
- 全仓自动化校验脚本（`scripts/verify-all.mjs` & `pnpm verify`）：串联 TypeScript Workspace 类型检查、Vitest 全量测试、以及 Flutter 移动端 `flutter analyze` 与 `flutter test`
- 移动端能力升级（`apps/mobile`）：
  - 实现 `FileCredentialStore` 持久化存储多台电脑凭据与当前激活机器
  - 实现 `PermissionRequestCardItem` 独立权限审批卡片（支持在手机端直接点击 `Allow Once` / `Reject` 回传 `permission.reply`）
  - 实现 `FileDiffCardItem` 与 `loadSessionDiffs()` 在会话时间线中渲染文件变更 Diff 统计
- 桌面端 Preload 与交互升级（`apps/desktop`）：
  - 实现 `createDesktopPreloadApi(ipcRenderer)` 桥接 Renderer 与主进程 IPC
  - 在 `renderDesktopAppHtml()` 中展示已配对设备列表（含平台、最后在线时间与一键撤销按钮）及 `window.nienieDesktop` 交互脚本
  - 实现 `DesktopPreviewServer` 本地可交互控制台服务（暴露 `GET /`、`GET /api/state` 与 `POST /api/ipc`）
- 移动端公网 Relay 传输层（`RelayBridgeTransport` in `apps/mobile`）：
  - 支持连接默认 `wss://nienie-replay.quniv.cn` 或用户自定义 Relay 地址并自动注册 `mobile` 角色
  - 实时感知 `relay.presence` 的 `bridgeOnline` 在线状态，并通过 `relay.forward` 双向收发命令与 `session.event`
- 全仓 TypeScript 构建流水线（`pnpm build`）：为所有 6 个 workspace 包配置 `outDir: "dist"` 与 `tsc` 构建输出，并纳入 `pnpm verify` 自动化校验
- 移动端局域网直连失败自动回退公网 Relay（`AutoFallbackBridgeTransport` in `apps/mobile`）：优先尝试局域网 `wsUrl`，不可达时自动切换至 `RelayBridgeTransport`（默认 `wss://nienie-replay.quniv.cn` 或用户自定义 Relay）
- GitHub Actions 跨端 CI 流水线（`.github/workflows/ci.yml`）：自动配置 Node.js 22、pnpm 与 Flutter 环境并执行 `pnpm verify`

### 2026-11-04 实现第二阶段扩展适配器（Claude Code 与 Pi）

- 实现 `@nienie/adapter-claude-code`（`ClaudeCodeAdapter` & `ClaudeCodeEventNormalizer`）：
  - 对接 `claude -p --output-format stream-json --verbose` 与 `--resume <session_id>`
  - 将 `system(init)`、`assistant(thinking/text/tool_use)`、`user(tool_result)`、`result(usage/error)` 统一映射为 Nienie `CanonicalAgentEvent`
- 实现 `@nienie/adapter-pi`（`PiAdapter` & `PiEventNormalizer`）：
  - 对接 `pi --mode json --session <id> -p` 结构化 JSON 流
  - 将 `agent_start`、`message_update`、`tool_execution_start`、`tool_execution_end`、`agent_end` 统一映射为 Nienie `CanonicalAgentEvent`

### 2026-11-04 实现第三阶段扩展适配器（ACP 通用适配器、OpenClaw 与 PTY/TUI 兜底适配器）

- 实现 `@nienie/adapter-acp`（`AcpAdapter` & `AcpEventNormalizer`）：对接 ACP JSON-RPC 2.0 `initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel` 与 `session/update` 通知归一化
- 实现 `@nienie/adapter-openclaw`（`OpenClawAdapter`）：对接 OpenClaw Gateway HTTP 会话与事件接口
- 实现 `@nienie/adapter-pty`（`PtyFallbackAdapter` & `stripAnsiSequences`）：清洗终端 ANSI 转义序列并转为 `text_delta` 事件，诚实声明受限 capability
- 实现独立后台守护进程与 Linux 无 GUI 模式（`HeadlessBridgeDaemon` in `@nienie/bridge-core`）：支持脱离 Electron UI 独立启动 Bridge、探测 Agent、生成一次性配对码并自动建立公网 Relay 出站连接
- 实现 iOS 和 Android 离线推送通知路由（`PushNotificationRouter` & `push.register`）：当无活跃手机连接且会话进入 `waiting`（等待审批）或 `error` 状态时，自动向已注册的 APNs/FCM/Webhook 设备派发经 `redactLogText` 脱敏的推送通知
- 移动端模型加载与切换（`loadModels` & `selectModel` in `apps/mobile`）：拉取 `models.list` 并在发送 Prompt 时附带当前选中的 `modelId`

## MVP 规划

- [x] Electron Bridge 启动和健康检查
- [x] OpenCode 适配器
- [x] Codex 适配器
- [x] 手机与电脑二维码配对
- [x] 手机会话列表
- [x] 手机会话详情
- [x] 流式文本事件
- [x] 工具调用和工具结果事件
- [x] 基础状态和错误事件
- [x] 手机发送 Prompt
- [x] WebSocket 断线重连
- [x] 公网 Relay 连接和设备路由
- [x] 自定义 Relay 地址配置
- [x] Relay 端到端加密消息转发
- [x] 基础权限请求展示

## 后续规划

- [x] 文件变更和 Diff 卡片
- [x] 模型选择和 Agent 能力展示
- [x] 会话恢复
- [x] 多台电脑管理
- [x] ACP 适配器
- [x] PTY/TUI 兜底模式
- [ ] 完整远程桌面兜底
- [x] iOS 和 Android 推送通知
- [x] Bridge 独立后台进程
- [x] Linux 无 GUI 模式
- [ ] Rust Bridge 评估和迁移

## 后续 Agent 适配路线

- [x] Claude Code 结构化流适配
- [x] Pi RPC 适配
- [x] 通用 ACP 适配器
- [x] OpenClaw Gateway 适配
- [x] 其他 JSONL / HTTP Agent 适配
- [x] PTY/TUI 通用兜底适配
