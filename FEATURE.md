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
  - `connectEvents()` & `parseSseStream()`：解析 `/event` SSE 流（支持分块帧、注释忽略、CRLF 兼容）。**按会话 directory 订阅** `GET /event?directory=<dir>`（OpenCode/MiMo 对带 `?directory=` 建的会话只推目录级事件流、不进全局 `/event`），`createSession` 记录 `projectPath` 供 `sendMessage`/`loadSession` 定位正确事件流，确保项目会话回复实时回流手机
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
- 远程桌面快照兜底（`ScreenCaptureProvider` & `screen.capture`）：支持已认证手机在极端 GUI 弹窗场景下请求受控的桌面窗口/屏幕快照帧（未授权请求严格返回 `UNAUTHORIZED`）
- 完成 Rust Bridge 架构评估与迁移规范（`docs/architecture/rust-bridge-evaluation.md`）：明确内存/启动基准、公网 Relay 优先迁移路径与 Wire Protocol v1 二进制兼容契约
- 实现 Relay 与 Headless Daemon CLI 启动器（`runRelayCli` & `runDaemonCli` in `@nienie/bridge-core`）：支持通过命令行参数或环境变量直接启动公网 Relay 与无 GUI 守护进程
- 桌面端全适配器矩阵集成（`includeExtendedAgents` in `apps/desktop`）：支持在桌面端一键启用并探测全部 7 类 Agent（`opencode`、`codex`、`claude-code`、`pi`、`acp`、`openclaw`、`pty`）
- 移动端远程桌面快照与推送绑定集成（`ScreenCaptureCardItem`、`captureScreen`、`registerPushToken` in `apps/mobile`）：支持在会话时间线中渲染桌面屏幕快照卡片并向 Bridge 注册 iOS/Android 推送凭据
- 生成 Flutter iOS 与 Android 原生宿主工程（`apps/mobile/ios` & `apps/mobile/android`）：配置 `cn.quniv.nienie_mobile` 包名及不依赖外部包的内联静态分析规则（`analysis_options.yaml`）
- 实现通用 JSONL 命令 Agent 适配器（`CustomJsonlAdapter` in `@nienie/agent-events` & `@nienie/bridge-core`）：支持接入任意自定义 JSONL CLI Agent，并将未知错误事件安全保留为 `UNRECOGNIZED_AGENT_ERROR`
- 移动端会话工具栏操作按钮（`btn-load-diffs` & `btn-capture-screen` in `apps/mobile`）：在会话输入栏提供一键查看文件变更 Diff 与一键获取桌面屏幕快照的触控入口
- 电脑端配对设备与撤销状态磁盘持久化（`persistenceFilePath` in `PairingManager`）：仅存储 `tokenHash` 摘要，使已绑定手机与已撤销设备状态在 Bridge 重启后自动恢复
- 移动端一键新建会话按钮（`btn-new-session` in `apps/mobile`）：在移动端顶栏支持一键创建新会话并自动切换至新会话视图
- 移动端二维码 URI 一键配对、Token 用量卡片与会话取消按钮（`pairWithQrUri`、`UsageSummaryItem`、`cancelActiveSession` in `apps/mobile`）：实现 7 类 `CanonicalAgentEvent` 在移动端的 100% 视觉卡片覆盖与一键中止运行中会话
- 移动端配对面板 QR URI 快捷输入框与按钮（`input-qr-uri` & `btn-pair-qr-uri` in `apps/mobile`）：支持直接粘贴 `nienie://pair?data=...` URI 一键完成配对连接
- 移动端已保存电脑列表与一键重连（`refreshSavedMachines` & `btn-reconnect-machine-*` in `apps/mobile`）：在配对面板展示已绑定电脑并支持一键凭 `deviceToken` 免扫码重连
- 移动端模型切换芯片栏、断开连接与移除保存电脑交互（`chip-model-*`、`btn-disconnect`、`btn-remove-machine-*` in `apps/mobile`）：完善多机器切换、退出连接与可视模型切换闭环
- 移动端点击 Agent 自动拉取模型列表与权限卡片 `Allow Always` 审批（`chip-agent-*` & `btn-perm-allow-always-*` in `apps/mobile`）：完善 Agent-模型联动与完整 3 态权限审批（`allow_once` / `allow_always` / `reject`）
- Mac 一键启动入口与 Android 真机网络权限配置（`pnpm start` / `scripts/start-mac.mjs` / `AndroidManifest.xml`）：
  - `pnpm start` 自动使用 `esbuild` 打包并启动本地 Bridge（`4100` 端口）与桌面浏览器控制台（`http://127.0.0.1:4101`），自动创建初始工作区会话并输出配对码
  - 修复 `AgentRegistry.listSessions()` 单适配器离线容错隔离
  - 在 `AndroidManifest.xml` 中配置 `INTERNET` 权限与 `usesCleartextTraffic="true"` 并完成 Android APK 构建
- 手机端与桌面端四国语言（中文 `zh`、英文 `en`、日文 `ja`、韩文 `ko`）国际化支持（`AppLanguage` / `NienieStrings` in `apps/mobile` & `DESKTOP_I18N` in `apps/desktop`）：
  - 手机端默认使用中文界面，并在顶栏提供 `中文 / English / 日本語 / 한국어` 实时语言切换菜单
  - 桌面端控制台支持 `zh`、`en`、`ja`、`ko` 四语渲染与顶栏语言下拉切换器
- 移动端代码模块化分层重构（`apps/mobile/lib/src/*`）：将 `lib/main.dart` 拆分为 `i18n`、`models`、`storage`、`transport`、`state`、`ui` 六大职责子模块，`main.dart` 仅保留 26 行启动入口
- 移动端 UI 与传输测试替身细粒度拆分（`pairing_panel.dart`、`timeline_card_list.dart`、`fake_bridge_transport.dart`）：将配对面板、时间线卡片列表与测试替身进一步解耦为独立小文件
- 用户语言偏好与桌面配置跨重启持久化（`saveLanguage` / `loadLanguage` in `apps/mobile` & `preferencesFilePath` / `setLocale` in `apps/desktop`）：手机端与桌面端切换中/英/日/韩语言后自动写入本地持久化文件，冷启动自动恢复上次选择的语言
- `pnpm start` 幂等重启保护（`scripts/start-mac.mjs`）：启动前自动清理残留的旧 `nienie-desktop.mjs` 进程，避免 `EADDRINUSE: 0.0.0.0:4100` 端口冲突
- Electron 原生桌面 GUI 窗口启动（`apps/desktop/src/electron-main.ts` & `pnpm start`）：运行 `pnpm start` 直接弹出带 macOS 原生红黄绿按钮（`titleBarStyle: 'hidden'`, `trafficLightPosition`）的 Electron 桌面控制台窗口（支持 `--headless` 切换纯命令行模式）
- 苹果 iOS/macOS + 微信清爽风格与紧凑首屏重构（`apps/desktop/src/renderer.ts` & `apps/mobile/lib/src/ui/*`）：
  - 桌面端与手机端统一采用苹果/微信浅色卡片风格（`#F2F2F7`/`#EDEDED` 底色、`#FFFFFF` 纯白圆角卡片、`#07C160` 微信绿主按钮、`#95EC69` 右侧用户对话气泡）
  - 桌面端将最重要的「手机扫码配对」置于首屏左上角第一焦点，「本机 Agents」按可用状态置顶并改为 2 列紧凑网格，次要「运行日志」置于底部，实现首屏零下滑总览
  - 手机端将「已保存的电脑」置顶一键重连，配对地址与 6 位配对码同行紧凑并排，大幅压缩工作区顶栏高度，最大化对话可视面积
- 真机摄像头扫码配对与标准 QR Code 编码闭环（`qrcode-generator` in `apps/desktop` & `mobile_scanner` / `QrScannerSheet` in `apps/mobile`）：
  - 桌面端使用标准 ISO/IEC 18004 编码生成真实可扫描 QR Code SVG，并自动填入本机局域网 IPv4 地址
  - 手机端配置 Android/iOS `CAMERA` 权限，在配对页置顶「扫码连接电脑」主按钮，调用摄像头识别二维码后自动完成配对（支持局域网不可达时自动回退 `127.0.0.1` USB 通道）
  - 修复手机端窄输入框标签 `...` 截断问题与空配对码友好四语提示
- 移动端扫码快速回退与默认会话激活优化（`apps/mobile`）：
  - `IoBridgeTransport.connect` 增加 2 秒连接超时控制，使 Wi-Fi AP 隔离环境下扫码可快速回退至 `127.0.0.1` USB 通道
  - 扫码识别后自动将 `wsUrl` 与 6 位配对码回填至表单，连接成功后自动激活首个可用会话直接展示对话输入栏
- 微信输入法（WeType macOS）同款视觉与排版体系重构（`apps/desktop` & `apps/mobile`）：
  - 桌面端采用左侧独立纯白大圆角悬浮导航栏（4 大分类：「手机连接」「AI 助手」「跨设备网络」「偏好与日志」，选中态采用微信输入法翡翠绿 `#17B378`）+ 右侧 `#F0F0F2` 浅灰画布与纯白分组设置卡片（`.wetype-group`）
  - 每一行采用 `14px` `font-weight: 500` `#1A1A1A` 主标题 + `12px` `#888888` 副标题 + `#F0F0F0` 极细分割线，搭配 iOS 翡翠绿胶囊拨动开关（`.wetype-switch`）、单选圆点（`.wetype-radio`）与 `#DCDCDC` 细描边次级按钮
  - 手机端同步对齐微信输入法分组列表行、翡翠绿 `#17B378` 与细描边按钮风格
  - 优化按钮与选择器细节：移除立即执行按钮后的 `...` 并配内联 SVG 图标，重写 `.wetype-select`（`appearance: none` + 自定义上下双箭头 SVG），并支持跨刷新记忆当前选中的导航 Tab
- 本机名称自动读取系统主机名与自定义持久化（`os.hostname()` & `setMachineName` in `apps/desktop`）：
  - 默认自动读取系统真实主机名（如 `MacBook-Pro-M5`，去掉 `.local` 后缀），替代硬编码的 `macbook_local`
  - 在「偏好与日志」页提供自定义本机名称输入框与保存按钮，修改后实时更新配对二维码并持久化写入 `.nienie/desktop-preferences.json`
- 微信输入法风格「升级和反馈」页面与作者赞赏码集成（`about` Tab in `apps/desktop`）：
  - 居中应用圆角图标徽章、`Nienie` 标题与 `0.1.0(100)` 版本号
  - 支持「有新版本时自动更新」开关切换与持久化（`setAutoUpdate`）、「我要反馈」一键复制脱敏诊断包、「赞赏与支持作者」展开微信赞赏码（`/assets/wechat-appreciate.jpg`）及沉底版权与协议声明
- 桌面端 UI 毫秒级无感热更新（Hot Reload in `scripts/start-mac.mjs` & `DesktopPreviewServer`）：监听 `apps/desktop/src/*.ts` 变更并自动通过 `esbuild` 重编译 `renderer-live.mjs`，经由 `/api/hot-reload` SSE 触发 Electron 窗口原地无闪烁自动刷新（保持 Bridge 连接与当前选中 Tab 不中断）
- 桌面端现代化 React 19 + Radix UI + Lucide Icons + Sonner 重构（`apps/desktop/src/ui/*`）：
  - 彻底替代早期原始 HTML 字符串拼接，采用 React 19 SSR（`renderToString`）+ 客户端无缝挂载（`/assets/desktop-client.js`）架构
  - 集成 `@radix-ui/react-tabs`、`@radix-ui/react-switch`、`@radix-ui/react-select`（毛玻璃弹出下拉菜单）、`@radix-ui/react-collapsible`、`@radix-ui/react-dialog`（用户协议与隐私政策弹窗）无障碍组件原语
  - 统一采用 `lucide-react` 矢量图标库、`@lobehub/icons-static-svg` 与 `opencode` 官方仓库的真实 Agent 品牌 SVG Logo，以及 `sonner` 灵动 Toast 通知反馈，彻底消除点击按钮或切换语言时的 `window.location.reload()` 整页刷新闪烁
- 手机端现代化 UI 与真实 Agent 品牌 Logo 重构（`apps/mobile/lib/src/ui/*`）：
  - 引入 `lucide_icons_flutter` 与 `flutter_svg`，全面替换默认 Material 图标，统一双端视觉语言
  - 实现 `AgentBrandLogo` 组件，在手机端 Agent 切换芯片、会话标签与对话气泡中渲染 OpenCode、Codex、Claude Code、Pi、ACP、OpenClaw 等真实官方 SVG 品牌标志
  - 升级 `PairingPanel`、`NienieMobileApp` 与 `SessionTimelineList` 为高定分组卡片（`1px` 细描边、柔和阴影、图标底座徽章与等宽代码容器），并在已 Root 的一加真机（`3B6F5KEAZ2KCEG3X`）完成构建、安装与拉起验证
- OpenCode 本地服务自动拉起、Codex macOS 系统代理自动注入与手机软键盘回车发送（`packages/agent-adapters/opencode`、`packages/agent-adapters/codex`、`apps/mobile`）：
  - `OpenCodeAdapter` 自动探测 `~/.bun/bin/opencode` 等路径下的 CLI 二进制并在 `127.0.0.1:4096` 未监听时自动后台拉起 `opencode serve --pure --port 4096 --hostname 127.0.0.1`
  - `CodexAdapter` 在 macOS 下自动通过 `scutil --proxy` 读取系统生效的 HTTP/HTTPS 代理（如 `127.0.0.1:10902`）注入 `codex exec` 子进程环境变量，解决中国大陆环境下连接 OpenAI Responses WebSocket 被重置（`os error 54`）无响应的问题
  - 手机端会话输入框支持软键盘回车/发送键（`TextInputAction.send` / `onSubmitted`）直接发送消息，且点击顶部可用 Agent 芯片自动切换至对应 Agent 的工作区会话
- 新增小米 MiMo Code（`mimo`）与 DeepSeek Harness（`dsh`）适配器、跨 NVM 版本自动发现 Claude Code，并隐藏底层协议兜底项（`packages/agent-adapters/*`、`apps/desktop`、`apps/mobile`）：
  - 实现 `MiMoCodeAdapter`（`id: 'mimo'`，对接 `/opt/homebrew/bin/mimo` 并自动拉起 `mimo serve --pure --port 4097 --hostname 127.0.0.1`）
  - 实现 `DshAdapter` & `DshEventNormalizer`（`id: 'dsh'`，自动发现 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，对接 `dsh --profile headless --json` 与 `--session-id` 恢复）
  - 增强 `ClaudeCodeAdapter` 自动扫描 `~/.nvm/versions/node/*/bin/claude`（自动发现本机 `v2.1.169 (Claude Code)`）
  - 在桌面端与手机端接入 `@lobehub/icons-static-svg` 的小米 MiMo（`xiaomimimo.svg`）与 DeepSeek（`deepseek-color.svg`）官方品牌矢量标志
  - 从面向用户的「本机 AI 助手」产品列表中移除抽象底层协议项（`ACP Agent` 与 `PTY Terminal Fallback`），仅展示真实的 AI 编程 Agent 产品
- 配对码消费后自动轮换、24 小时有效期与配对设备跨重启持久化（`PairingManager`、`DesktopBridgeController`、`MobileBridgeClient`）：
  - 手机扫码消费一次性配对码后，桌面端通过 `onDevicePaired` 自动立即生成新配对码并实时同步至桌面 UI，避免二次扫码报 `Pairing code is invalid or expired`
  - 将桌面端配对码默认有效期延长至 24 小时，并将已绑定手机凭据哈希持久化至 `.nienie/paired-devices.json`，使 `Ctrl+C` 重启 `pnpm start` 后已配对手机依然有效
  - 修复移动端 `pairWithQrUri` 仅在 WebSocket 建连失败时回退 `127.0.0.1`，避免 `pair.confirm` 成功后因后续异常重复提交已被消费的一次性配对码
- 手机端 Kelivo 2.0 极简视觉重构与「多电脑 × 多 Agent × 项目空间树」三级联动（`apps/mobile` & `packages/agent-adapters/*`）：
  - **后端各 Agent 本地项目与历史会话真实发现**：
    - `CodexAdapter` 自动读取本机 `~/.codex/state_5.sqlite`（`threads` 表）与 `~/.codex/.codex-global-state.json`（`electron-saved-workspace-roots`），还原全部本地工作区项目（如 `nienie`、`audio_cut`、`openctrlc`、`ideaboom` 等）与历史线程
    - `OpenCodeAdapter` / `MiMoCodeAdapter` 同时聚合 `GET /project` 与 `GET /session`
    - `ClaudeCodeAdapter` 与 `DshAdapter` 自动扫描 `~/.claude/projects` 与 `~/.dsh/sessions` 下的项目目录与历史会话文件
  - **手机端 Kelivo 1:1 极简对话视图（`nienie_mobile_app.dart` & `timeline_card_list.dart`）**：
    - 移除顶部三层拥挤横条，采用 Kelivo 同款长短双横线菜单按钮（`list.svg`）+ 双行无框顶栏（主标题显示会话名，副标题显示 `<项目名> · <Agent> (<电脑名>) ▾`）
    - 底部采用 Kelivo 标志性的 `R22` 双层圆角悬浮输入舱（上层 100% 全宽无遮挡输入框，下层集成 Agent 真实彩色胶囊切换条、工具按钮与 `32px` 圆形发送钮）
    - 对话流升级为无外框通栏 Agent 响应 + 紧凑单行工具调用胶条（`#F7F8FA`）+ 右侧浅灰圆角用户气泡
  - **左侧滑出抽屉三级联动架构（`kelivo_workspace_drawer.dart`）**：
    - 第一级：顶部电脑切换器（`MacBook Pro M5 ⌄`），支持多台电脑切换与一键扫码添加新电脑
    - 第二级：当前电脑下的 Agent 选择条（`Codex` / `OpenCode` / `Claude Code` / `MiMo Code` / `DeepSeek Harness`）与全宽胶囊按钮「新建任务」
    - 第三级：按项目文件夹分组的 `空间 (N) ⌄` 树形列表（`📁 nienie`、`📁 audio_cut`、`📁 openctrlc` 等），支持展开/折叠项目下的历史会话、点击「查看更多」以及点击文件夹右侧 `+` 号直接在该项目路径下新建会话
- 移动端启动自动重连与 Bridge 重启断线自动恢复（`loadSavedPreferences(autoReconnect: true)` & `transport.disconnected` in `apps/mobile`）：
  - App 启动时若本地存在已保存电脑凭据（`deviceToken`），自动静默发起 `hello` 免扫码重连（并在局域网 IP 变化时自动回退尝试 `127.0.0.1` USB 通道）
  - 当电脑端重启 `pnpm start` 导致 WebSocket 断开时，`IoBridgeTransport` 触发 `transport.disconnected` 并自动后台重试 `reconnectWithSavedCredential` 恢复连接，无需用户重新扫码
- 历史会话聊天记录同步回放与空会话自动创建（`emitSqliteSessionHistory` / `emitCodexThreadHistory` in `packages/agent-adapters/*` & `openSession` / `sendMessage` in `apps/mobile`）：
  - 在手机端抽屉点击 OpenCode、MiMo Code 或 Codex 的任意历史会话时，`loadSession` 自动从本机 `opencode.db`、`mimocode.db`（`part JOIN message`）及 `thread_history_*.sqlite`（`thread_items`）读取过往的用户提问、Agent 回复与工具调用记录并渲染到手机主对话页面
  - 主对话页面底部 `R22` 输入舱常驻显示，当在空白新对话状态下直接输入指令发送时，自动创建当前选中 Agent 的新会话并发送消息
- Nienie 官方网站上线与双端安装包分发（`website/index.html` & `https://nienie-web.pages.dev`）：
  - 对齐 `openctrlc` 暖米白编辑感设计体系（`--page-bg: #f6f5f1`、`--page-ink: #1f2521`、自动深浅色模式与中英双语切换），无任何含用户隐私的真机截图
  - 构建 Android 发布版安装包（`Nienie-v0.1.0-android.apk`）与 macOS Apple Silicon 桌面客户端（`Nienie-v0.1.0-macos-arm64.zip`）并上传至京东云 MinIO（`https://file.quniv.cn/resource/nienie/`）
  - 官网托管于 **Cloudflare Pages**（`https://nienie-web.pages.dev`，`wrangler pages deploy`），双端安装包大文件则分发于京东云 MinIO（`https://file.quniv.cn/resource/nienie/`）；提供直链下载、短链重定向与手机浏览器扫码下载二维码

### 2026-11-08 修复项目会话回复不回流 + 补齐事件回流守卫、诊断工具与等待态

- **修复项目会话事件回流**（`packages/agent-adapters/opencode/src/index.ts`）：改为按会话 directory 订阅 `GET /event?directory=<dir>`，解决「OpenCode/MiMo 对带 `?directory=` 建的会话不向全局 `/event` 推事件、手机只见用户气泡无回复」的根因（详见 `FailureExperience.md`）
- **事件回流守卫测试**（`packages/agent-adapters/opencode/tests/events-emit.test.ts`）：mock 精确复刻真实 OpenCode 事件投递语义（目录会话事件只投目录级订阅者），锁定「带 projectPath 建会话 → sendMessage → 必收 text_delta 且必须订 `/event?directory=<projectPath>`」，谁改回全局流立即变红
- **一键诊断脚本**（`scripts/diag-opencode-sse.mjs`）：对比「建会话是否带 `?directory=`」×「订阅全局还是目录级 `/event`」四组合的事件数并输出结论，用于快速定位「回复生成了但不显示」类问题
- **手机端「等待回复」加载态 + 超时兜底**（`apps/mobile`）：发送后即显示 `Thinking…` spinner 占位卡片（`PendingResponseItem`），收到 `text_delta`/`thinking_delta`/`tool_use` 或 `session.idle` 即收起；超 45 秒无回复自动切换为「Reply timed out + Retry / Check desktop」兜底卡片，Retry 可一键重发该 prompt

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
- [x] 完整远程桌面兜底
- [x] iOS 和 Android 推送通知
- [x] Bridge 独立后台进程
- [x] Linux 无 GUI 模式
- [x] Rust Bridge 评估和迁移

## 后续 Agent 适配路线

- [x] Claude Code 结构化流适配
- [x] Pi RPC 适配
- [x] 通用 ACP 适配器
- [x] OpenClaw Gateway 适配
- [x] 其他 JSONL / HTTP Agent 适配
- [x] PTY/TUI 通用兜底适配

### 2026-11-09 统一 P6 小猫品牌图标

- 采用 P6 小猫图案作为 Nienie 的唯一品牌图标，保留 1254 × 1254 PNG 母版，增加 `pnpm brand:assets` 脚本统一生成网站、桌面端与手机端尺寸。
- 替换官网页眉和 favicon；提供 16–512 px PNG favicon、ICO、Apple touch icon 和 PWA manifest。
- 替换 Electron「关于」页图标，并设置 macOS Dock、BrowserWindow 图标；提供 PNG、ICO、ICNS 多尺寸资源。
- 替换 Flutter 手机端页眉图标，并生成 iOS 全尺寸 AppIcon、Android 密度图标和 Android adaptive icon。
- 将 Android 与 iOS 启动画面同步为小猫图案和匹配的蜜桃背景；平台启动器图标由操作系统应用圆角遮罩，界面内小图标按组件尺寸裁切。

### 2026-11-08 抽象 AgentEventConnectionManager + SSE 自动重连与历史补偿 + 链路诊断

- **`AgentEventConnectionManager`**（`packages/agent-events/src/connections.ts`，transport-agnostic）：统一管理事件流的「建立 / 去重 / 断线重连 / 释放」，输入 `AsyncIterable<unknown>`（SSE 解析流、子进程 stdout 行流、SQLite 历史流通用）。特性：per-key（directory）连接、in-flight 去重、断线指数退避+抖动自动重连、`onReconnect` 钩子、`status()` 诊断、`dispose` 生命周期。OpenCode/MiMo 适配器复用；后续 Codex/Claude Code 亦可接入。
- **SSE 自动重连**：断线后不再等下次 `sendMessage` 才重连，后台按退避自动重建，正在生成的回复不再因瞬断丢失。
- **事件历史补偿**：`emitSqliteSessionHistory` 改增量回放（`p.rowid > 水位`，幂等），`onReconnect` 触发对已加载会话的增量补发；历史与实时事件共享 normalizer 的单调 sequence（`nextSequence`）避免撞号。
- **Bridge `/diagnostics` 路由**（`ws-server.ts`）：聚合 machineId / connectedClients / 每会话事件缓冲计数 / 各适配器 SSE 连接状态（连接数、重连次数、最后事件时间）。
- **B 诊断脚本升级为链路自检表**（`scripts/diag-opencode-sse.mjs`）：新增「OpenCode Health → Create Session → Session Directory → SSE HTTP → SSE Connected → Prompt HTTP → Session Status → Assistant Text Delta → Session Idle」全链路逐步状态表，一键定位「后台生成但不显示」断在哪一环。

### 2026-11-08 事件可靠性协议：streamEpoch + partId 复合水位 + 幂等历史恢复

- **`streamEpoch` 事件流实例标识**（`packages/protocol`）：`CanonicalAgentEvent` 新增 `streamEpoch`，每次 Adapter/事件流实例生成新 epoch。客户端按 `(sessionId, streamEpoch, sequence)` 判重排序，Bridge/进程重启后 sequence 重置不再被误判为旧事件。
- **历史恢复升级为 partId + emittedLength 复合水位**（`emitSqliteSessionHistory`）：弃用 rowid 水位（无法发现已有 part 的 UPDATE），改为按 `partId → 已回放长度` 只补发缺失后缀，幂等且能捕获内容增长；tool 调用按 `callId` 去重只发一次。完整分页（LIMIT 200 循环）。
- **稳定历史 eventId**：`history:{sessionId}:{partId}:{revision}`，配合客户端 `eventId` 幂等去重，多次重连/重放不重复追加。
- **手机端判重升级**：`eventId` 幂等去重（去重稳定事件 ID）+ `sessionId#streamEpoch` 感知的 sequence 判重（epoch 变化即重置）。
- 每条历史事件带 `streamEpoch` + `partId` + `partRevision`，为后续 part-snapshot 精确恢复铺垫。

### 2026-11-08 事件可靠性协议推广到 Codex / Claude Code 适配器

- **修复 streamEpoch 每事件随机 bug**：`createCanonicalEvent` 不传 `streamEpoch` 时会为每个事件单独生成随机 epoch，导致 Codex/Claude Code/dsh 事件的客户端 `(sessionId, streamEpoch, sequence)` 判重全部失效。给 `CodexEventNormalizer` / `ClaudeCodeEventNormalizer` / `DshEventNormalizer` 各加实例级 `streamEpoch` + `nextSequence()`，`buildEvent` 显式盖戳，历史回放与实时事件共享同一 epoch + 单调 sequence。
- **Codex 历史恢复升级**（`emitCodexThreadHistory`）：eventId 稳定为 `history:{sessionId}:{itemId}:{revision}`（原 `cx_hist_${randomUUID()}` 不幂等），按 itemId + 已回放长度增量补发缺失后缀（幂等 + 捕获更新），SQL 补取 `created_at_ms` 还原原始时间戳，commandExecution 补 `tool_result`（exit_code/aggregated_output）配对，分页读取。
- **Claude Code 新增历史回放**（`emitClaudeSessionHistory`）：从 `~/.claude/projects/**/<sessionId>.jsonl` 逐行回放（原手机端打开旧会话空白），复用 assistant/user 分支映射（thinking/text/tool_use/tool_result），eventId 稳定为 `history:{sessionId}:{uuid}:{idx}`（jsonl 行 uuid），按行 uuid 去重幂等。
- 同步 `docs/protocols/canonical-events.md`：事件信封补 `streamEpoch`，设计要求明确 `(sessionId, streamEpoch, sequence)` 判重 + 稳定 eventId 幂等语义。

### 2026-11-10 官网 Agent 卡片同步桌面端官方品牌图标

- **修复官网 5 个 Agent 图标显示**（`website/index.html`）：官网「支持的 Agent」卡片原本把 OpenAI Codex、Xiaomi MiMo Code、DeepSeek Harness 画成纯色圆点占位（`<circle r="9"/>`），只有 OpenCode / Claude Code 是品牌 SVG；桌面端 `apps/desktop/src/ui/AgentBrandIcons.tsx` 早已内置 5 个官方 SVG，但官网是独立静态页从未同步。
- 用脚本从 `AgentBrandIcons.tsx` 提取 5 段官方 SVG（含 Codex 渐变、MiMo 字标、DeepSeek 鲸鱼），把 JSX 属性转成 HTML 属性后内联进官网卡片，尺寸统一 22×22 并加 `aria-hidden="true"`；不引入外部图片或 CDN 依赖，不受 CSP 与资源缓存影响。
- 本地无头 Chrome 与线上 `https://nienie-web.pages.dev` 截图像素完全一致，5 个图标均正常显示；已用 `wrangler pages deploy website --project-name=nienie-web --branch=main` 发布到生产环境。
- 同步修正文档里的官网地址：`https://nienie.quniv.cn` 从未配置 DNS（死链），官网实际地址为 `https://nienie-web.pages.dev`。

### 2026-11-10 官网 favicon 破缓存与缓存策略修正

- **修复浏览器标签页仍显示旧绿色 N 图标**：`website/favicon.ico` 与各尺寸 PNG 内容其实已是 P6 小猫、线上文件哈希与本地一致，问题是浏览器把旧 favicon 缓存住了（新图标生成后直到本次才真正部署到 Pages，且图标走 `/assets/*` 的 24 小时 + stale-while-revalidate 缓存）。
- `website/index.html` 给 `favicon.ico`、`nienie-icon-16/32.png`、`apple-touch-icon.png`、`site.webmanifest` 全部加 `?v=2` 版本号，强制浏览器重新拉取；以后换 logo 只需递增版本号。
- `website/_headers`：图标类资源不再走 `/assets/*` 的长缓存——`/assets/*` 统一改为 `max-age=3600, must-revalidate`，`favicon.ico` 与 `site.webmanifest` 单独设 `max-age=0, must-revalidate`。注意 CF Pages 会把多条匹配规则的 Cache-Control **合并**（不是覆盖），必须避免规则重叠产生自相矛盾的响应头。
- 线上验证：5 个 `?v=2` 资源均 200 且内容与本地一致，首页 200，各资源只返回单条 Cache-Control。

### 2026-11-10 J0.5 OpenCode v2 服务发现（只读连接验证）

- **背景**：手机建的会话桌面 OpenCode.app 看不到，根因是 Nienie 对接的 OpenCode v1（`~/.bun/bin/opencode` 1.19.5，写 `opencode.db` 的 `session/message/part` 表）与桌面 OpenCode v2.2.5（写 `session_v2/session_message/session_part` 表）是两套存储，v1→v2 迁移是一次性的（详见 `FailureExperience.md`）。已定方案 A2：Nienie attach 桌面 v2 共享服务，不双写、不直连 sqlite。
- **新增 `packages/agent-adapters/opencode/src/service-discovery.ts`**：按 OpenCode 官方 `service-probe.ts` 语义实现服务发现与身份验证——读注册文件（`<state>/opencode/service.json` / `service-local.json` / `service-<channel>.json`，字段 id/version/url/pid/password），用 `Basic opencode:<password>` 请求 `GET /api/info`，校验返回 `pid` 与注册一致、`version` 与注册一致后才返回 `{baseUrl, version, pid, username, password}` 端点。
- **失败原因分级**（`OpenCodeServiceDiscoveryReason`）：`not_found`（无注册文件）/ `invalid_registration`（文件损坏）/ `unreachable` / `unauthorized` / `incompatible`（404 或响应体不合法）/ `identity_mismatch`（pid 不一致）/ `version_mismatch` / `failed`（500）/ `not_ready`（503 启动中）。错误信息与日志永不携带密码。
- **状态根目录双候选**：官方规则是 `XDG_STATE_HOME || ~/.local/state`，但桌面 GUI 启动的 opencode-cli 在干净环境下注册到 `~/.local/state`，而终端环境（如本机 openctrlc）可能把 `XDG_STATE_HOME` 指到别处导致发现不到。发现逻辑按序探测两个根目录下的全部候选注册文件，收集所有通过 `/api/info` 身份验证的候选后判定（多实例且非同一实例时报 `ambiguous`，见 J0.5.1）。
- **验收**：31 个单测覆盖（缺失/损坏/401/404/非 JSON/pid 不匹配/版本不匹配/500/503/网络失败/多注册回退/密码不泄漏/多根目录探测）；真机冒烟发现桌面 v2.2.5 服务 `http://127.0.0.1:49374`（`0xC0DE` 固定服务端口，pid 与桌面 `opencode-cli serve --service` 进程一致），确认 Nienie 可 attach 到与桌面同一个服务实例，不会启动第二个 Server。此为 J0.5（Phase 1 只读连接验证）验收点。

### 2026-11-10 J0.5.1 服务发现加固（按 ChatGPT 审查反馈）

- **URL 严格校验 + 凭据外泄防护**（`normalizeLocalServiceUrl`）：注册文件 URL 必须是 http/https、不得带 URL 内嵌凭据（userinfo）、主机必须是回环地址白名单（127.0.0.1 / localhost / [::1] / 0.0.0.0→127.0.0.1 重写）；不合格直接 `invalid_registration` 且**绝不发起请求**（防止把 Basic Auth 密码发往外部主机）。fetch 加 `redirect: 'error'`，禁止重定向跳到别的主机。非法 URL 不再抛异常中断候选回退循环。
- **可选字段类型严格校验**：`version`/`password`/`id` 存在但类型不是 string 时按官方 Service.Info Schema 语义拒绝整个注册文件（原实现会静默当不存在，导致退化成无认证访问）。
- **503 分类修正**：503+HTML 响应体不再被误判成 `incompatible`。（后被 J0.5.2 按官方 `service-probe.ts` 语义再修正：503 也必须先解析 body 并验证 pid/version 身份，再分类 `not_ready`；503+HTML→`incompatible`、503+pid 不符→`identity_mismatch`。）
- **多实例歧义保护**：不再"第一个验证通过就返回"——收集全部验证通过的候选，若存在多个且按官方 `same()` 口径（id/version/url/pid）不属于同一实例，返回 `ambiguous` 要求显式指定 stateDir；同一实例的重复注册正常合并。发现优先级：`NIENIE_OPENCODE_STATE_DIR`（显式）→ `XDG_STATE_HOME` → `~/.local/state`，注册文件按 `service.json` → `service-local.json` → 其他 channel 文件排序。
- **规划修正**（ChatGPT 厘清）：J0 遗留的"数据恢复问题"= ToolCallCardItem.status 丢失（Snapshot 恢复后 running/completed/failed 丢失、UI 用 `resultContent != null` 推断状态），与 partId/revision 幂等归约是两个独立问题，均归 J0.4，在 J0.7 之前必须收尾；diffId 映射归 P2 在 J0.6b v2 Diff 适配时用稳定派生 ID 解决（v2 FileDiff 只有 patch/additions/deletions/status，无 diffId/before/after）。
- 测试 39 个（新增非法 URL 不发请求、503 HTML、可选字段类型、歧义、同实例合并、NIENIE_OPENCODE_STATE_DIR 优先级等）；真机冒烟继续正确发现桌面 v2.2.5 服务。

### 2026-11-10 J0.5.2 服务发现封板（按 ChatGPT 复审意见，含其自我纠正）

- **URL 必须是服务根地址**：`normalizeLocalServiceUrl` 拒绝带 path/query/fragment 的注册 URL（探测请求 `/api/info` 会丢弃 path，但 endpoint.baseUrl 原样保留会拼错后续 API 路径）；`endpoint.baseUrl` 统一取 `url.origin`。
- **503 语义按官方 `service-probe.ts` 修正**（ChatGPT 纠正其上轮建议）：503 也必须先解析 body 并验证 pid/version 身份再分类——503+JSON+身份匹配→`not_ready`，503+HTML→`incompatible`，503+pid 不符→`identity_mismatch`。即"先确认服务身份，才能认定它处于等待状态"。
- **`redirect: 'error'` 补直接断言**：fetch mock 校验请求确实带 `redirect: 'error'`。
- **FEATURE.md 自洽**：修正 J0.5 条目里"第一个验证通过的胜出"的过期描述（J0.5.1 起已是收集全部有效候选+歧义判定）。
- 测试 41 个；真机冒烟继续正确发现桌面 v2.2.5 服务。ChatGPT 结论：J0.5 核心功能正式通过，J0.5.2 后封板，批准并行启动 J0.6a（OpenCodeV2Client）。

### 2026-11-10 J0.6a OpenCodeV2Client（v2 HTTP API 客户端）

- **新增 `packages/agent-adapters/opencode/src/v2/client.ts` + `v2/types.ts`**：独立封装 `OpenCodeV2Client`（HTTP 请求逻辑不散落在 Adapter 里），统一 Basic Auth（`opencode:<password>`）、JSON 序列化、`redirect: 'error'`、AbortSignal 超时（默认 15s）、ID 全部 `encodeURIComponent`。Schema 严格对照 OpenCode v2.2.5 官方契约（`packages/protocol/src/groups/*.ts` + `openapi.json`），不引入 v1 兼容层。
- **端点覆盖**（J0.6a 范围，不含事件/快照/SQLite）：`GET /api/info`；Session List（扁平查询参数 `limit/order/search/parentID/archived/directory/project/subpath/cursor`，响应 `{data, cursor:{previous,next}}` 游标分页）/ Create（`{title, location:{directory}, model:{id,providerID,variant?}}`）/ Get / Delete（204）；Model List（`location[directory]` deepObject 参数 + `types` 重复参数，响应 `{location, data}`）/ Default（`data` 可为 null）/ Provider List；Model Switch（`POST /api/session/:id/model`，body `{model:{id,providerID,variant?}}`，204）；Prompt（`{text, id?, files?, agents?, skills?, metadata?, delivery?: steer|queue, resume?}`，**无 model 字段**，返回 `{data: Inbox.User}` = 入队回执而非执行完成）；Interrupt（无 body，`resume?: "true"|"false"` 字符串查询参数，返回 `{interrupted}`）；Permission Reply（`{decision: once|always|reject, message?}`，204）。
- **错误处理**：非 2xx 抛 `OpenCodeV2ClientError`（`status` + `tag`（响应体 `_tag`，如 `SessionNotFoundError`）+ `message`），网络失败/超时 `status: 0`，非 JSON 错误体回退状态码消息。
- **Schema 关键坑位（写入测试防回归）**：模型引用字段是 `id` 不是 `modelID`；Session 列表是扁平 `directory` 参数而 Model/Provider 是 `location[directory]`；Prompt 响应是入队回执（`type: 'user'` 的 Inbox 记录），不能当执行完成；Interrupt 的 `resume` 是字符串布尔。
- 测试 57 个（新增 v2-client 16 个：全端点请求形状/查询编码/204 空体/URL 编码/错误提取/网络失败/无密码不发认证头/redirect 断言）；真机只读冒烟成功列出桌面 v2 会话（crawler_console 的 K8s 排查、ideaboom 的 RabbitMQ 研究），确认与桌面同库同源。

### 2026-11-10 J0.6a.1 OpenCodeV2Client 收尾（按 ChatGPT 审查意见）

- **查询参数拆分**：`getDefaultModel`/`listProviders` 只接受 `OpenCodeV2LocationQuery`（仅 `location[directory]`），`types` 仅 `listModels` 可传（官方 `GET /api/model/default`、`GET /api/provider` 不接受 `types`）。
- **类型按官方 openapi.json 修正**：`Model.Info.canonical`/`Provider.Info.canonical` 是 `string`（Provider.ID）不是 boolean；`Model.Cost.tier` 是 `{type:'context', size:number}` 对象；`Session.ForkBoundary` 为 `{type:'before'|'through', messageID}` 联合；`permissions` 为 `{action, resource, effect:'allow'|'deny'|'ask'}` 数组；`revert` 为 `{messageID, partID?, snapshot?, files?: FileDiff.Info[]}`；`Inbox.User` 响应侧文件附件是 `{data, mime, source, name?, description?, mention?}`（与请求侧 `{uri, source?, ...}` 不同），`skills` 响应含 `id`+`name`，`delivery` 收窄 `'steer'|'queue'`；`cursor.previous/next` 允许 null；补 Model/Provider 的 `compatibility`（含 reasoningField/maxTokensField/cacheFormat/mediaInput 等）与 `package/settings/headers/body` 字段。
- **响应体严格化**：非 204 成功响应空 body 不再静默返回 undefined，抛 `OpenCodeV2ClientError`（协议错误）；JSON 解析失败包装为 `OpenCodeV2ClientError` 并保留 HTTP status；`response.text()` 读取失败也统一包装为 status 0 传输错误。
- **构造防御**：`OpenCodeV2Client` 构造函数复用 `normalizeLocalServiceUrl` 校验 baseUrl 必须是本地服务根地址（防止未来误传任意 URL 把 Basic Auth 凭据外发）；baseUrl 统一取 `url.origin`。
- 补测试：409 ConflictError / 400 InvalidCursorError 标签保留、空 body、坏 JSON、响应体读取失败、超时 status 0、构造拒绝非本地 URL、Default/Provider 不带 types。测试 64 个。
- **开发顺序确认**（ChatGPT 决定）：J0.6a.1 封板 → J0.4（ToolCallCardItem.status + partId/revision 幂等归约）→ J0.6b（Diff + Message API + diffId 稳定派生 + 移除 v1 SQLite 读取）→ J0.7（Snapshot/事件集成）。

### 2026-11-10 J0.4 ToolCallCardItem 显式状态 + partId/revision 幂等归约（手机端数据模型）

- **`ToolCallStatus` 显式生命周期**（`timeline_items.dart`）：新增 `enum ToolCallStatus { pending, running, completed, failed }` 与 `parseToolCallStatus`；`ToolCallCardItem` 增加 `status`（默认 running）、`partId`、`revision` 字段。状态是领域数据：**禁止用 `resultContent != null` 推断成败**（completed 可以没有输出、running 可能已有部分输出）。`StreamingTextItem` 同步增加 `partId`/`revision`。
- **状态生命周期**（reducer `_applyCanonicalEvent`）：`tool_use` → running；`tool_result` → completed/failed（按 isError）；completed/failed 为终态，`tool_use` 重放不回退状态；Snapshot 按 part 的显式 `status` 恢复（streaming/running/completed/error 的 v1→Nienie 映射在适配器侧，手机只认 pending/running/completed/failed）。
- **partId + revision 幂等归约**：per-session `_partRevisionBySession`（partId → 已应用最高 revision）；事件带 `partId`+`partRevision` 时——同 revision 重放丢弃、低 revision 晚到不覆盖新状态、高 revision 正确更新；文本按 partId 精确定位归属 item 增量追加（不再依赖「最后一个文本 item」启发式）；工具按 `toolCallId` 幂等 upsert（多次断线重连/epoch 切换重放不重复生成卡片）。无 partId 的事件走原有兼容路径。
- **Snapshot 安装**：恢复 tool 状态/`partId`/`revision`，并以快照 revision 播种版本表（快照是权威状态，之后同/低 revision 的补偿事件被丢弃）。
- **UI 按状态渲染**（`timeline_card_list.dart`）：状态图标来自 `status`（pending=circleDashed/running=loaderCircle/completed=check/failed=circleX），结果内容只决定可展开性；边框红色只看 `status == failed`。
- **验收矩阵**（mobile_app_test.dart 新增 5 组）：Snapshot 恢复 running/completed(空输出)/failed(空错误) 三态正确 + UI 图标按 status；相同 partId+revision 重放不重复追加/不重复卡片；高 revision 更新、低 revision 晚到不覆盖（文本与工具终态均验证）；历史补偿与实时事件并发最终一致且单卡片；多 epoch 重放（reducer 级模拟重连，非完整断线重连集成测试）不重复卡片、终态不回退。22 个手机端测试全绿，flutter analyze 无问题，仓库全量 127 vitest 全绿。
- **明确留给后续的跨源一致性问题**（本轮不做，避免扩大范围）：a) v1 快照构建器 `revision` 硬编码 1、与历史事件 `partRevision`（文本累计长度）口径不可比，且 reasoning/step/patch/file part 会导致构建抛错（真实会话暂无法走快照路径）——随 J0.6b/J0.7 用 v2 Message API 重建快照时解决；b) 实时事件（normalizer）不携带 partId/revision，门禁目前只覆盖历史/合成事件——J0.7 统一归约时补齐。

### 2026-11-10 J0.4b 归约修正（按 ChatGPT 首轮 Diff Review 反馈）

- **P1 用户消息 part 归属**：`UserPromptItem` 增加 `partId`/`revision`，user `text_delta` 与 assistant 一样按 partId 精确定位、增量追加、`markApplied()` 记录版本（原实现直接 break 造成：重放产生重复用户消息、同 part 后续增量变成新消息）。
- **P1 终态不可逆**：`tool_result` 原来无条件覆盖状态（completed↔failed 可互跳）。改为单向状态机：pending→running→completed/failed，completed/failed 为吸收态——不同终态的结果既不改状态也不覆盖内容；同终态只在版本更新时更新内容；tool_use 重放永不回退终态。
- **P2 占位卡补齐**：`tool_result` 先到产生的占位卡，后到的 `tool_use` 补齐真实工具名（覆盖占位名 'tool'）与 input 缺失字段；`ToolCallCardItem` 构造时防御性拷贝 input map（原 `const {}` 不可变 map 会令补齐静默失败）。
- **UI**：展开的结果文本颜色也改按 `status == failed` 判断（原用 isError，与图标/边框口径不一致）。
- **补测试**（ChatGPT 要求的 A-E）：用户文本 partId 幂等（重放不重复+高 revision 追加）；终态不可逆（含跨 epoch 无 partId 冲突结果、同终态内容更新）；Snapshot revision 播种真正生效（同/低 revision 补偿丢弃、高 revision 追加、revision=6 断言）；两个文本 Part 交错互不串扰；工具结果先于声明（name/input 补齐+终态不回退）。手机端 27 测试全绿。
- **ChatGPT 划界确认记录**：v1 快照构建器问题（revision=1 与历史 partRevision=文本长度口径不可比、reasoning/step/patch/file part 构建抛错、v1 工具 `error` 状态映射缺失）全部归 J0.6b/J0.7 验收条件；实时事件缺 partId 戳记归 J0.7（新增验收项：同一文本 Part 跨 epoch 重补发不得重复追加）；J0.7 还需 Snapshot 请求串行化/generation 防护（旧快照不得覆盖新快照）。

### 2026-11-10 J0.6b-1/2 v2 Message/Diff API + 消息恢复层（数据读取迁移第一步）

- **J0.6b-1 客户端**（`v2/client.ts` + `v2/diff-id.ts`）：`listMessages`（`GET /api/session/:id/message`，limit/order/cursor/type；官方明确 cursor 不可与 order 同传——客户端直接拒绝并抛错）；`getSessionDiff`（`GET /api/session/:id/diff`，from/to/context，返回 `{data: FileDiff.Info[]}`）；`deriveDiffId` = `sha256(JSON.stringify(['diff:v1', sessionId, fromMessageId, toMessageId, file, patch]))`——五个字段必须是已解析的非空字符串（拒绝 undefined/null/空串），数组序列化天然无字段拼接歧义。
- **J0.6b-2 消息恢复层**（`v2/message-restore.ts`，纯函数）：v2 `SessionMessageInfo[]`（user/assistant content[]，含 text/reasoning/tool）→ Nienie 历史事件规格 + `SessionSnapshotPart[]`。稳定 partId 派生：用户文本 `${messageID}:0`、assistant 内容块 `${messageID}:${ordinal}`（与 v2 实时事件的 (assistantMessageID, ordinal) 身份一致）；partRevision 沿用 J0.4 的单调版本约定（文本=累计长度、tool called=1/result=2）；payload 携带 `messageId` 供本地乐观消息关联（J0.4b 遗留 P1 的解法基础）。
- **v2 工具状态映射**：streaming/running→running、completed→completed、error→**failed**（修复 v1 映射缺失的 error 态）；输出抽取：completed=Tool.Content 文本块连接（file 块标记 `file:name|uri`）、error=error.message；streaming 态的字符串 input 尝试 JSON 解析否则空对象。
- **turn 范围解析**（`resolveDiffTurnRange`）：from 缺省=最新用户消息、to 缺省=from 自身，返回解析后的真实 User Message ID 供 diffId 使用；校验 from/to 必须是用户消息且 to 不早于 from（ChatGPT 要求的"实际生效 turn 范围"）。
- 测试 79 个（新增 8：四态映射/输出抽取/事件规格顺序与 partId/revision/快照显式 status 与 ordinal/turn 范围默认与校验/diffId 公式与敏感性与空值拒绝）。
- **待 ChatGPT 裁决的划界**（见下轮审查）：会话 CRUD/写入/事件切换与 v1 SQLite 读取删除的先后；streaming→running 还是 pending（两轮审查口径不一致）；乐观消息 messageId 需要 session.send 响应携带（协议小变更）。

### 2026-11-10 J0.6b-3a 审查修正（ChatGPT 裁决落地）

- **裁决 A（streaming 映射）**：`mapV2ToolStatus('streaming')` 改为 **pending**（streaming=模型还在生成工具参数、未执行；running=已进入执行）。且 tool_use 事件携带显式 `status`，手机端 reducer 采纳规则：新建卡采纳 requestedStatus（v1 无 status 默认 running 兼容）；pending→running 允许升级；running→pending 禁止降级；completed/failed 吸收态不变。
- **裁决 B**：J0.6b-3 采用 **B2**（含最小 v2 SSE 接入，SSE 用独立长连接处理器而非 client.request）；J0.7 专注 Durable Log/watermark/快照串行化；**v1 SQLite 删除推迟到新旧读取真实数据对照通过后**（对照前保留 fallback）。
- **裁决 C**：乐观消息关联增加请求侧 `clientMessageId`（手机生成 msg_xxx → session.send → prompt body.id，响应 messageId 校验一致），消除「SSE 先于 send 响应到达」竞态。
- **diffId 允许空 patch**（二进制/无 hunk 差异合法），仅要求 string；其余四字段仍须已解析非空。
- **无损转换**：error 工具同时保留错误信息与部分输出（`boom\npartial`）；file 块保留 name|uri 双字段（`file:name|uri`）；空文本但带附件的用户消息不消失（合成 `file:name|uri|mime`/`agent:`/`skill:` 摘要行）。
- **Schema 严格化**：Assistant.agent/model 必填、ToolState.Running.metadata 必填、Completed.content 非空元组、OtherMessage 九种类型按官方逐字段建模（Shell/Skill/Synthetic/System/Compaction/Idle/AgentSelected/ModelSelected/LocationSwitched）、limit 收敛 number|string 口径。
- **分页**：新增 `listAllMessages` 完整分页器（首页显式 order=asc、后续页 cursor-only 且过滤条件不变）；restore/resolve 强制升序输入（降序抛错）。
- 测试 141 vitest + 28 mobile 全绿。剩余 J0.6b-3b..g（clientMessageId 协议、Session CRUD/写入切 v2、Message/Snapshot/Diff 实际接入、最小 v2 SSE、真实数据对照、移除 v1 SQLite）按序进行。

### 2026-11-10 J0.6b-3b clientMessageId/messageId 乐观消息关联（裁决 C 落地）

- **协议**（向后兼容，PROTOCOL_VERSION 保持 1）：`session.send` 请求新增可选 `clientMessageId`；响应 `data.messageId` 可回传服务端权威消息 ID。已更新 `docs/protocols/mobile-bridge.md` 样例与兼容性说明。
- **链路贯通**：`AgentAdapter.sendMessage` options 增加 `clientMessageId`、返回 `{messageId?}`（既有适配器 `Promise<void>` 实现无需改动）；`SessionRouter.sendMessage`/`ws-server` 透传并回传 messageId；OpenCode 适配器签名同步（v2 prompt 将在 6b-3c 用 `body.id = clientMessageId` 并校验回显一致）。
- **v1 历史回放补 messageId**：`emitSqliteSessionHistory` 的 SQL 取 `m.id AS message_id`，user/assistant 文本增量与 tool 事件 payload 均携带 messageId——认领机制在现有链路即刻生效，不用等 v2 切换。
- **手机端**（J0.4b 遗留 P1 正式解决）：`UserPromptItem.messageId` 字段；`sendMessage` 发送前生成 `msg_<ts>_<seq>` 打标到本地乐观消息、随请求发送、响应回填权威 ID；reducer 认领语义——同 messageId 的未认领乐观消息只绑定 partId/revision 并以权威文本对账（不重复追加首个全文）；后续增量按 J0.4 partId/revision 门禁；无匹配才新建。消除「SSE 先于 send 响应到达」与「断线重连后历史重放重复用户消息」两个竞态。
- 测试：手机端新增认领用例（打标断言 + 首次认领不重复 + 重放门禁），29 mobile + 141 vitest 全绿。
- **附带排障**（记入 FailureExperience）：flutter/dart 进程静默卡死是 `bin/cache/lockfile` 残留锁 + dart 二进制被 macOS quarantine 卡在 dyld Gatekeeper 校验，删锁文件后放行。

### 2026-11-10 J0.6b-3c/3d 适配器数据面切换 v2（会话 CRUD/写入/历史/快照/差异）

- **v2 模式**（`OpenCodeAdapter` 新增 `mode: 'v1'|'v2'` + `v2Endpoint`）：默认 v2——attach 桌面 OpenCode 共享服务（`discoverOpenCodeService()` 发现，仅连接不启动，服务不可用则明确报错提示启动 Desktop，不回退 v1）；`NIENIE_OPENCODE_API=v1` 或显式 baseUrl/fetch/envUrl 配置时走 v1 回退路径（含 mimo 适配器保持 v1）。
- **会话层切 v2**：`listSessions`（`GET /api/session?parentID=null&order=desc`）/ `createSession`（`{title, location:{directory}, parentID}`）/ `loadSession` / `sendMessage`（`switchModel` 后 `prompt {id: clientMessageId, text}`，**校验回显 messageId 一致否则抛错**，返回 `{messageId}`）/ `cancel`（interrupt）/ `replyPermission`（allow_once→once、allow_always→always、reject→reject）/ `listModels`（model/default/provider 三接口 + drafts.sqlite 可见性过滤）全部走 `OpenCodeV2Client`。
- **读取层切 v2（3d）**：`loadSession` 触发 `emitV2MessageHistory`（`listAllMessages` 完整分页 → `restoreHistoryEvents` → 稳定 eventId `history:{sid}:{partId}:{revision}` 回放）；`getSessionSnapshot` 用 Message API + `buildSnapshotParts`（显式 tool status、revision 与事件同口径）；`getSessionDiff` 用 `resolveDiffTurnRange`（缺省最新用户消息 turn）+ v2 Diff API + `deriveDiffId`（真实 turn 范围哈希）。
- **diffId 正式修复（J0 P2 结清）**：`SessionFileDiff` 增加必填 `diffId`（sha256 稳定派生）；v1 回退路径用 `legacy-v1` 哨兵范围派生（确定性）；手机端 FileDiffCardItem 改用 `map['diffId']`（不再拿文件路径当 ID）。v2 的 patch 文本暂由 `after` 字段承载（before 空），J0.7 UI 重构时换 patch 结构。
- 测试 147 vitest（新增 v2 模式适配器 6 用例：detect/list/create/send 模型切换+回显校验/cancel/权限映射/历史恢复 eventId/快照/turn 范围 diffId）+ 29 mobile 全绿。
- **状态**：6b-3c/3d 完成；剩余 3e（最小 v2 SSE）、3f（真实数据对照）、3g（移除 v1 SQLite）。

### 2026-11-10 J0.6b-3e 最小 v2 SSE 实时事件（B2 裁决落地）

- **新增 `v2/sse.ts`**：`streamV2EventFrames` 独立长连接处理器（`GET /api/event` 全局流、Basic Auth、`redirect:'error'`、`parseSseStream` 解帧——不进 `client.request` 的 15s JSON 通道）+ `V2LiveEventMapper` 实时映射器。
- **事件映射**（最小可用集）：`session.text/reasoning.delta|ended` → text/thinking 增量（partId=`${assistantMessageID}:${ordinal}` 与恢复层同身份；ended 按累计水位补缺后缀，全量已到则不重复）；`session.tool.input.started` → tool_use status=pending、`input.ended`/`called` → running（input 解析）、`success`/`failed` → tool_result（failed 保留 error.message+部分输出）；`execution.started/succeeded/failed/interrupted` → status running/idle/cancelled（failed 另发 error 事件）；`permission.asked` → status waiting+权限卡；`session.usage.updated` → usage。未知事件忽略（有意的 Timeline Projection）。
- **适配器接线**：v2 模式事件流统一 key `v2-global`（全局流不再按 directory 订阅）；实时帧 eventId 从源 `evt_` id 派生（`v2:{id}`，跨重放稳定）；`sendMessage` 前强制建立事件流（强一致门禁保留）；断线重连补偿改为对所有已加载会话跑 `emitV2MessageHistory`（幂等 eventId+revision 门禁保证不重复）。
- **真机冒烟**：连接桌面 v2 共享服务 `/api/event`（Basic Auth）8 秒收到帧、鉴权与解帧正常；映射器单测覆盖 delta/ended 补缺、工具四态、执行/权限/用量映射。
- 测试 153 vitest（新增 v2-sse 6 用例）+ 29 mobile 全绿。**至此 6b-3c/3d/3e 完成：手机建会话（桌面可见）→ 发消息 → 实时流式回复的 v2 数据通路全链路打通**；剩余 3f（真实数据对照）/3g（移除 v1 SQLite）。

### 2026-11-10 J0.6b-3f 新旧读取真实数据对照（证据链）

- **新增 `scripts/compare-v1-v2-restore.ts`**（bun 运行）：对 `opencode.db` 中 v1∪v2 交集且含工具调用的真实会话，分别走 v1 SQLite 读取（适配器同款 SQL）与 v2 Message API 恢复（`restoreHistoryEvents`），归一化成语义项（user_text/assistant_text/tool{name,input,output,status,isError}）逐项语义比对（文本含 contains 语义、input JSON 规范化、工具状态同口径映射）。
- **实测结果：8 个真实会话（含迁移批次）203/203 项全部一致（100% matched，0 missing）**——消息数量、顺序、User/Assistant 文本、Tool Input/Output/状态在新旧读取间语义相等。reasoning 作为 v2 相对 v1 的增量改进单独统计不计入缺失。
- **Diff 维度**：v2 Diff API 请求构造与 diffId 稳定性验证通过（错误 from 正确 404）；发现老迁移会话带悬空 `assistant.snapshot` 引用时服务端 500（OpenCode 侧容错缺失，见 FailureExperience），新建 v2 会话 diff 正常。
- **3g 划界待裁决**：v1 SQLite 读取代码物理删除会破坏 mimo 适配器（走 v1/mimocode.db 路径）与 `NIENIE_OPENCODE_API=v1` 回退；当前已按模式隔离（v2 模式绝不触碰 v1 SQLite）。建议保留隔离现状、待 mimo 迁移后统一删除。

### 2026-11-10 J0.6b-3.1 终审修复（2 P1 + 对照严格化 + 附件 + Diff 降级）

- **P1-1 协议解析丢 clientMessageId**：`parseBridgeRequest` 的 session.send 分支原来漏提取该字段（裁决 C 实际断链——prompt 不带 body.id、认领失效）。已补提取 + `^msg_[A-Za-z0-9_-]+$` 格式校验（缺省/空串/非法格式不透传）+ wire 解析穿透测试（present/absent/empty/invalid/类型错 5 例）。
- **P1-2 一帧多事件 eventId 互吞**：`session.execution.failed` 映射 error+status 两事件共用 `v2:{frame.id}` 被手机 eventId 去重吞掉其一（状态卡 running）。改为 `v2LiveEventId(frameId, type, index)` 稳定子 ID（`v2:evt_x:error:0`/`v2:evt_x:status:1`），重放稳定且互不吞。
- **Mapper 水位播种**（3c/3d 遗留）：`seedPartLength`——历史恢复时把各 partId 已有长度种入实时映射器，打开生成中的会话后实时 delta 的 partRevision 续接历史（原从 0 重来被门禁丢弃）。
- **附件结构化保留**（不再随文本静默丢失）：`userMessageAttachments` 输出结构化元数据（name/mime/sourceType/uri 或 inline SHA-256 摘要），历史事件 payload 带 `attachments`、快照 message part 以 `resource` 块承载（手机快照校验放行 resource 块）；纯附件无文本消息仍合成摘要防消失。
- **对照脚本严格化**：按时间线顺序逐位匹配（不再任意位置 findIndex）、严格相等（工具 input JSON 规范化后精确比、output 精确比）、synthetic 摘要/明确豁免外**多余即失败**、附件入比对项、新增 plain（纯对话）模式与迁移统计（v1_only/v2_only/intersection）、diffId 拆双指标（跨请求 deterministic + 单响应 unique）+ v1/v2 文件集合对比。实测：tools 8 会话 203/203 有序匹配、plain 6 会话 12/12、**2 项已知 v1 截断**单列（v1 `state.output` 尾部多字节截断、v2 content[] 完整，前缀关系验证后归入 knownV1Truncations）。
- **Diff 500 降级态**：`session.diff` 失败返回 `{diffs: [], unavailable: true}`（「无变更」≠「算不出」），手机端 `diffUnavailableFor` + 明确提示「此历史会话的文件差异暂不可用，可能与旧版本迁移数据有关」，可重试。
- **分页防御**：`listAllMessages` 补 cursor 死循环检测、重复消息 ID 检测、空页带 next 报错、limit 正整数校验。
- 测试 155 vitest（协议 9 + adapter 102）+ 29 mobile 全绿。

### 2026-11-10 J0.6b-3.2 封板收尾（一次性提交）

- **截断豁免收窄为精确白名单**：弃通用前缀规则，只允许逐项人工核实过的 2 个 v1 Tool Output（ses_f2ea6da23ffe… 的两个 websearch，按 toolCallId+v1 输出 SHA-256 精确匹配）；**普通文本必须严格相等**，无任何豁免。
- **附件比较规则**：URI 型比 URI、inline 型比 SHA-256（v1 `file` part 的 data: URL 现场解码算哈希对照 v2 的 contentHash），name/mime 同比。
- **附件端到端可见**：`UserPromptItem.attachments`（name/mime/sourceType/uri/contentHash）——事件 payload 附件保存、快照 resource 块转换为附件（**不丢弃**）、UI 在用户气泡内显示「文件名 · MIME」行（paperclip 图标）。
- **Diff unavailable 降级展示**：活跃会话时间线内显示 `DIFF_UNAVAILABLE` 可重试提示卡（不再只有全局 errorMessage）；重试前清理旧差异卡与提示卡，**不重复生成**。
- **对照脚本**：API 失败计入 `diffUnverified`（不计为比较成功），汇总行 `diffVerified/diffUnverified/diffIssues` 分开。
- **limit 校验**：number/string 双向验证正整数（`Number()`+`isSafeInteger`，封堵 `'1.5'`/`'-10'`/`'abc'`/`''` 绕过）。
- 测试 155 vitest + 31 mobile（+2：附件端到端含 UI 断言、Diff 降级+重试去重）全绿。

### 2026-11-10 J0.6b-3.3 Final Acceptance Fix

- **截断白名单升级四点全等**（`v2/restore-compare.ts` 独立模块）：sessionId + toolCallId 双边相等 + v1 输出 SHA-256 + v2 输出 SHA-256 全部精确匹配才判 `v1-truncated`；错误 v2 输出/换 toolCallId/换会话一律 mismatch。
- **synthetic 摘要显式标记**：restore 层空文本附件消息的合成摘要带 `syntheticSummary: true`，对照不再用 `file:` 前缀猜测——普通用户消息以 `file:` 开头照常严格比对。
- **Diff 白名单退出语义**：v1 Diff API 非 2xx/网络错误计入 `diffUnverified`；**白名单（11 个已核实旧迁移会话）外的 API 失败计入 diffIssues → 脚本非零退出**。
- **附件补齐两处**：已有 UserPromptItem 的增量更新分支同样保存附件；快照 inline 资源（`inline:<hash>`）还原 `sourceType='inline'`+`contentHash`（不再误标 uri 型）。
- **JSON 规范化**：工具 input 比对用键序稳定序列化（`stableStringify`）。
- **测试**（新增 restore-compare 模块 6 例 + restore synthetic 2 例 + mobile 1 例）：白名单错误 v2 输出必须 mismatch、toolCallId 不等 mismatch、`file:` 前缀无豁免、附件 URI/哈希不混比、白名单外 diff 失败语义、更新分支附件、inline 还原。基线 192 vitest + 32 mobile 全绿。

### 2026-11-10 J0.6b-3.4 Final Seal

- **equal 路径补 toolCallId 身份校验**：工具比对 headEqual 含 `toolCallId 非空且双边相等`——toolCallId 不同但 output 相同也判 mismatch（含空 toolCallId）。
- **v1 Diff fail-closed**：`fetchV1DiffFiles` 非 2xx/网络错误/非数组响应一律抛错（不再吞成空数组）；`classifyDiffFailure` 分侧——v2 已知旧迁移 500 仅按白名单豁免为 unverified，**v1 失败/网络错误/未核实错误一律 fatal 进 diffIssues（脚本非零退出）**，白名单不扩大为通用 API 失败豁免。
- **测试补齐**：toolCallId 不同+output 相同→mismatch、空 toolCallId→mismatch、可注入白名单的 v1-truncated 正向命中（双哈希精确）、v2 输出变化不命中、v1 Diff 500/网络错误/非数组/正常四路 mock、失败分类四象限（v2 白名单内/外 × v1/v2）。adapter 114 测试。
- 基线：196 vitest + 32 mobile 全绿。

### 2026-11-10 J0.6b-3.5 Final Seal（白名单最小授权）

- **`classifyDiffFailure` 只豁免真实 HTTP 500**：改为接收错误对象并以 `instanceof OpenCodeV2ClientError && status === 500` 判定（status 从错误提取，不接受调用方随意传入）；网络错误（status 0）、401/404/429、普通异常、undefined 一律 fatal。
- **catch 作用域收缩**：抽 `verifySessionDiffs` 统一验证——白名单豁免仅作用于 `client.getSessionDiff` 的 HTTP 500；`resolveDiffTurnRange` 本地异常、diffId 计算异常、v1 API 失败/网络错误/非法响应一律 fatal（fail-closed）。
- **验收表七行全覆盖测试**：v2+白名单+500→unverified；+0/404/401→fatal；v2 非白名单+500→fatal；v1 任意错误→fatal（不吃 v2 白名单）；本地 resolveDiffTurnRange 异常→fatal；全一致→ok。
- 基线：202 vitest（adapter 120）+ 32 mobile 全绿。

### 2026-11-10 J0.6b 正式封板（OFFICIALLY SEALED @ e73d5cd）

- ChatGPT 终审九维全过：ToolCall 身份一致性 / 严格文本比较 / 附件一致性 / Synthetic 处理 / Snapshot 一致性 / v1-truncated 精确白名单 / Diff fail-closed / HTTP 500 最小授权 / catch 作用域隔离。J0.6b 不再追加验收要求。
- **J0.6b 全程**：3a Schema/状态机 → 3b clientMessageId → 3c/3d v2 数据面（手机会话桌面可见闭环）→ 3e 最小 v2 SSE → 3f 严格对照（203/203）→ 3.1-3.5 五轮审查收尾，共 13 个 commit（97df99c…e73d5cd）。
- **J0.7a GO**（Durable Log Client）设计三原则：`DurableCursor = string` opaque token（不解析/不假设格式）、Durable Cursor 与 Nienie Sequence 双序列空间由 Watermark 层映射、恢复语义优先（断线恢复/重复读取/游标推进/进程重启/并发消费一致性）；第一阶段只做接口+分页读取+游标传递，不混入 Snapshot/事件合并/移动端恢复。

### 2026-11-11 路线图#1 通知系统（产品体验 P0）

- **WebhookPushSender**（bridge-core/push.ts）：POST JSON `{title, body, sessionId, deviceId, platform, timestamp}` 到桌面配置的 Webhook URL（Bark/ntfy/自建通用）；附带 ntfy 兼容 `title` header（UTF-8 标题按 latin1 字节通道传递，规避 fetch 头值 latin1 限制，接收端按 UTF-8 还原——Node/undici 真实 HTTP 测试锁定该行为，Bun fetch 行为不同勿用于生产验证）。
- **三类推送**：任务完成（status idle）、等待审批（status waiting）、执行出错（error）；正文注入会话标题（ws-server 用 sessionIndex 解析）更有信息量；正文过 redactLogText 脱敏。
- **偏好**（路线图 1.5）：全局开关、会话静音列表、免打扰时段（HH:mm，start 含 end 不含，支持跨午夜）；pushToken 去重（多设备同通道只发一份）；`notifyTest` 测试链路。
- **桌面设置页**（Tab 4）：通知配置区（Webhook URL/开关/免打扰时段/静音会话）+ 保存 + 发送测试通知按钮，4 语言文案入 DESKTOP_I18N；偏好持久化 preferences.json；IPC `set-notifications`/`test-notification`。
- 测试：bridge-core +7（webhook 真实 HTTP 中文标题还原、完成/审批/出错、偏好过滤、去重、免打扰边界、测试发送），全仓 208 vitest 全绿。

### 2026-11-11 路线图#1 二轮修复 R1-R10（按 ChatGPT 终审清单）

- **R1** IPC 映射单一源：`DESKTOP_PRELOAD_METHODS`（controller 导出）供 preview-server 注入层同步使用，杜绝两处手维护漏更新。
- **R2** Webhook 模式不依赖设备注册：`notifyEvent` 移除 registrations 前置闸，webhookSender 为全局单目标每事件一次；deviceSender（apns/fcm 预留）按注册逐设备。
- **R3** Sender 动态配置：webhookSender 闭包每次发送读取最新 URL/类型，改配置立即生效（原 startBridge 定死 sender 的 bug 修复）。
- **R4** 异常隔离：`notifyEvent` 全链路吞错（onDeliveryError 上报日志），ws-server 双保险 `.catch`，通知失败绝不影响 Bridge 主进程。
- **R5** 三类 Sender：BarkPushSender（JSON+url 深链）/ NtfyPushSender（Topic 模式正文纯文本 + Title RFC2047 + Click/Actions）/ WebhookPushSender（通用 JSON），`createPushSender` 按类型或 auto 特征（day.app→Bark、含 ntfy→ntfy）识别；URL 校验（http/https、禁 userinfo）。
- **R6** 目标语义分离：webhook 单目标一次、设备级按 (provider,pushToken) 去重；真实 HTTP 测试锁定 Bark url 字段与 ntfy actions 中文经 latin1 字节通道还原（Bun/Node 差异再次确认：验证必须在 Node 运行时）。
- **R7** 撤销联动 `revokeDevice→unregisterDevice`；webhook 模式天然无注册依赖（重启可用）；原生 token 持久化预留。
- **R8** 外发隐私：`sanitizePushBody`（redactLogText + 默认脱敏家目录/绝对路径）、`detailed` 详细模式开关（默认关）、设置页隐私提示文案（4 语言）、凭据文件 chmod 0600。
- **R9** 深链：通知带 `nienie://session/<id>`（Bark url 字段 / ntfy Click+Actions「打开会话」），手机端 `handleDeepLink` 未加载挂起、sessions 刷新后自动进入会话（app_links 接入 + Android/iOS scheme 配置）；审批入口=打开 App 内已认证审批页（不做未认证 HTTP Action）。
- **R10** 测试按钮吃草稿 URL/类型（不经旧配置），文案「Webhook 连接成功」。
- P2 顺手：ws-server 冷启动预热 sessionIndex（离线通知也有会话标题）、事件级去重（同 eventId 只推一次）。
- 测试：bridge-core 46（+4）+ mobile 33（+1 深链）+ 全仓 210 vitest 全绿；另修 Flutter SDK ink_sparkle.frag 缺失问题（改用 InkRipple 水波纹，产品更克制且不依赖 shader 资源）。

### 2026-11-11 路线图#1 三轮修复（通知不丢失 / 断线可恢复 / 敏感不外泄）

- **失败可重试**：eventId 只有投递成功才记入去重（失败不记，重复事件可触发重试）；每次发送带一次自动重试。
- **深链断线保护**：离线时保留 pendingDeepLinkSessionId、openSession 成功才清除；重连 + refreshSessions 后自动重试进入（测试覆盖「缓存→断线→深链→重连→进入」）。
- **路径脱敏重写**：默认模式把 macOS/Linux `/(Users|home)/x/...`、Windows `C:\Users\x\...`、UNC 路径整条折叠为 `~/`或`…/` + 文件名（不泄漏项目名/目录结构）；三平台路径回归测试；详细模式保留原样。
- **Preview Server CSRF**：`/api/ipc` 校验一次性随机 token（页面注入）+ Origin 仅本机 + 通道白名单（DESKTOP_PRELOAD_METHODS）；测试覆盖无 token/恶意 Origin 403。
- **完成通知真实摘要**：ws-server 从会话事件历史取真实文本尾部作摘要（≤120 字），无数据降级普通完成通知（不伪造）。
- **P2 一并**：sessionIndex 预热可等待（消冷启动竞态）、sendTestNotification 直发不经 Router（绝不静默成功）、createDesktopPreloadApi 由 DESKTOP_PRELOAD_METHODS 统一构建、auto 识别域名收紧（day.app/官方 ntfy 域，自建用显式类型）+ 边界测试。
- **多设备语义明确**：当前推送门禁为全局单设备语义（任一授权端在线即不推送）；多设备级门禁与应用层 ACK 留待后续（FEATURE 与路线图不宣称多设备闭环）。
- 测试：bridge-core 50（+4）+ desktop 6（含 CSRF 拒绝）+ mobile 34（+1 断线深链）；全仓 214 vitest 全绿。

### 2026-11-11 路线图#1 Round 4（封板条件四项）

- **延迟重试队列**（R3-4）：后台退避重试 1s/5s/15s/60s（可注入调度器/序列），per-target 重试、全部目标成功才记 delivered、期间 inFlight 去重防并发重复、超限终态失败经 onDeliveryError 记录并释放 inFlight 允许后续重触发——「两次立即失败永久丢通知」的缺陷消除。
- **路径脱敏重做**（R8）：独立 PATH_SEGMENT 字符类（含空格/Unicode，排除标点边界），POSIX/Windows 盘符/UNC 三类正则，整条折叠为 `~/`/`…/`+文件名（basename 不合法则整体 `…`）；带空格路径（`My Documents/private project`）与 UNC 回归测试通过；修掉字符类被 `]` 提前闭合的静默失效 bug。
- **Preview Server Host 校验**（安全）：全路由入口校验 Host ∈ {127.0.0.1:port, localhost:port, [::1]:port}（防 DNS Rebinding）；`/api/state`（含 webhook 凭据字段）带 Origin 时仅允许本机来源；node:http 原始请求测试伪造 Host → 403、恶意 Origin → 403、正常 → 200。
- **空配置语义**：webhookSender 闭包空 URL 抛错按投递失败处理（绝不静默记 delivered），重复事件可重触发。
- 并发相同事件 in-flight 去重测试（gate 拦截验证只派发一次）；凭据存储定位修正为「文件权限保护（0600）」，不宣称加密（safeStorage/Keychain 留后续）。
- 测试：bridge-core 53（+3：重试恢复/终态/并发/空配置）+ desktop 6（+Host/Origin 拒绝）；全仓 217 vitest + 11 typecheck 零 error 全绿。

### 2026-11-11 路线图#1 Round 5（封板前最后三项边界）

- **CI 环境确定性**：subosito/flutter-action 钉 `flutter-version: 3.47.9` + `cache: true`（channel:stable 漂移导致 3.48 的 material 弃用 INFO 刷屏挂掉 CI；SDK 升级另安排，不与本修复混做）。
- **多目标 delivered 语义修正**：settleJob 改为 per-key `{pending, allSucceeded}` 结算——**全部目标成功才 markDelivered**，任一终态失败不记 delivered（同事件后续副本可重触发）；双设备回归测试（A 成功/B 终态失败→可重触发；B 恢复后全成功→delivered 去重）。
- **路径脱敏边界**：`/var/folders` 带空格路径按「扩展名+边界」惰性收尾（不再 `\S+` 截断泄漏 `id…/file.txt`，也不吞句尾）；POSIX 根目录文件 `/secret.txt` 支持折叠 `…/secret.txt`；**单遍归一化替换**修掉「WIN 改写产物 `~/main.py` 又被 POSIX 规则二次命中成 `~…/main.py`」的串扰；补充样例测试（带空格 macOS/Windows/UNC、Unicode 目录、var/folders、根目录文件）。
- 测试：bridge-core 59（+6）；全仓 223 vitest + 34 mobile 全绿。

### 2026-11-11 路线图#1 Round 5.2 路径标点边界脱敏（封板前最后一处）

- **文件扩展名锚定**（FILE_ANCHORED_RE）：路径中段允许 `!`、`()`、逗号等 POSIX/Windows 合法标点与空格/Unicode，以「根起点…文件名.扩展名+终止边界」识别完整路径——`C:\Users\alice\private!project\src\main.py`→`~/main.py`、`/Users/alice/private(project)/src/main.ts`→`~/main.ts`，不再只匹配前缀泄漏剩余目录。
- **占位符暂存**（`\u0000N\u0000`）：TMP/文件锚定/兜底三类规则之间互不二次命中，最后统一还原。
- **fail-closed 收紧**：尾段含空格无法确认是文件名时整体折叠 `~/…`（不泄漏「secret stuff」）；basename 白名单改为无空格单 token。
- 测试：bridge-core 62（+3：`!`/`()` 标点、逗号分号相邻、fail-closed 折叠）；全仓 226 vitest 全绿。

### 2026-11-11 路线图#1 Round 5.3 路径脱敏完整性（整体匹配策略，封板前最后一步）

- **匹配策略重写**（不堆特例）：FILE_ANCHORED_RE = 根起点（POSIX/Windows/UNC）→ 任意中段（含 `!`、`()`、单引号、空格、Unicode，不再有 `\u6000` 类误终止）→ 文件 `.ext[:line[:column]]` + 终止边界；失败则 DIR_FALLBACK_RE 到硬边界**整体折叠**（禁止同一绝对路径的前缀式部分脱敏）。
- **Stack Trace 后缀**：`:42`/`:42:7` 归入路径锚定并保留输出（`~/main.py:42: secret`）；basename 剥离行号后缀再走白名单。
- **单引号歧义**：按路径合法字符处理（歧义时整体折叠优先于泄漏前缀）——`private!project's secrets/src/main.py`→`~/main.py`。
- **fail-closed**：无扩展名目录路径折叠为 `~/<叶名>`（叶名含空格则 `~/…`）；UNC 输出 `\\…\叶名`。
- 回归（ChatGPT 点名全数）：`private!怀疑目录` Unicode+标点、POSIX/Windows/UNC 无扩展名目录、单引号、Stack Trace 双格式、原有 10 项样例保持。bridge-core 66 测试；全仓 230 vitest 全绿。

### 2026-11-11 路线图#1 Round 5.4 目录名带点不得冒充扩展名（封板）

- **匹配原则修正**（非加特例）：文件扩展名必须是路径**最终文件名**的扩展名且**纯字母**——`project.v1`/`v1.2.3` 等「目录名带点」不做文件锚定（`.v1` 含数字不是扩展名）；basename 白名单同规则（带点名的扩展名必须纯字母，否则 `…`）。
- 结果：`cd /Users/alice/project.v1`→`cd ~/…`；点号目录在中段时后续文件名正常锚定（`project.v1/src/main.ts`→`~/main.ts`、`file.txt:12` 行号保留）；纯字母扩展名文件名正常显示（`~/main.py`）。
- 顺带修：Stack Trace `:42: secret` 边界（END_BOUNDARY 补 `:`，扩展名纯字母规则已消除目录误判风险）；fail-closed 语义明确（无扩展名路径向后整体折叠，宁可过度）。
- 回归：R5.4 三组场景入测试；bridge-core 69 测试、全仓 233 vitest 全绿。

### 2026-11-11 路线图#1 Round 5.4b 锚定守卫（前缀泄漏根治）

- **SLASH_GUARD**：文件锚定后同一子句（到硬边界）内不得再出现路径分隔符——`.private!dir/src` 这类「点号目录+边界字符+后续路径」不再提前锚定（前缀泄漏与 R5.3 同根因的复发消除）：`cat /Users/alice/.private!dir/src`→`cat ~/src`、`.private!x/y.log, ok`→`~/y.log, ok`。
- 修一处转义回归：END_BOUNDARY 的 `\\s` 曾被写成单反斜杠（JS 字符串 `\s` 退化为字符 `s`），导致根文件 `/secret.txt`、Stack Trace 锚定失效——修正并留测试锁定。
- bridge-core 70 测试、全仓 234 vitest 全绿。

### 2026-11-11 路线图#1 Round 5.4c Unicode 路径边界完整性（隐私封板）

- **保守边界语义统一**：HARD_STOP 收窄为「真正不可能出现在路径中的字符」（`\r\n"<>|`）——全角逗号 U+FF0C、全角空格 U+3000、顿号 U+3001 等**合法路径字符**不再作为提前终止点；SLASH_GUARD 扫描、文件锚定中段、DIR_FALLBACK 三处共用同一停止集（一致语义）。`cat /Users/alice/project.private，secret/src/main.py`→`cat ~/main.py`（三个 Unicode 反例全过）。
- 文档计数修正：测试数量以 CI 日志为准（本轮全仓 240 vitest：protocol 9 / agent-events 23 / 适配器 9 / opencode 120 / bridge-core 73 / desktop 6）。
- 路径脱敏反例全集（R5.2→5.4c）均已入回归：带空格三平台、Unicode 目录、标点目录、单引号、Stack Trace 行号、`.v1` 目录、`.private` 前缀、Unicode 标点、var/folders、根文件。

### 2026-11-11 路线图#1 Round 5.4d POSIX 合法路径字符边界（隐私封板终章）

- **平台化边界语义**（不再对所有 OS 用同一 HARD_STOP 假设）：POSIX 文件名仅排除 `/` 与 NUL——`"` `<` `>` `|` 均为合法路径字符，POSIX 路径的中段/守卫只以换行为界；Windows/UNC 路径仍以 Windows 禁用字符（`" < > | ? *`）为终止。引号包裹的路径随匹配吞掉并剥离。
- 你点名的反例通过：`cat '/Users/alice/.private"secret/src/main.py'` → `cat ~/main.py`（目录名 `secret` 不泄漏）；`x<y|z>/src/main.ts` → `~/main.ts`；`a<b>c/d<e` → `~/…`。
- 顺带修两处静默未生效的旧补丁（扩展名词边界 `(?![\w-])` 防 `.v1` 的 `.v` 被当扩展名、WIN 规则补全句守卫）——这正是 `.private` 反例的另一半根因。
- 计数口径修正：以 CI 日志为准，本轮全仓 242 vitest（protocol 9 / agent-events 23 / 适配器 10 / opencode 120 / bridge-core 75 / desktop 6 = 243，以 CI 为准）。
- 路径脱敏反例全集 R5.2→5.4d 共 30+ 例全部入回归。

### 2026-11-12 路线图#1 通知系统 正式 ACCEPTED（结项）

- ChatGPT 终审签署：**路线图 #1 正式 ACCEPTED**（commit 87cdeb9，CI 243/243 全绿，六项封板标准全达成，未发现新增隐私泄漏）。验收维度：CI 确定性、多目标 delivered 语义、in-flight 并发去重、Host/Origin 安全、路径脱敏（R5.2～5.4d 六轮隐私边界）、深链断线恢复。
- 非阻断记录：PATH_ROOT 平台规则重叠（POSIX 规则先于 Windows 规则执行，Windows 路径被保守过度折叠——不泄漏、仅过度），登记在案不再扩展。
- **路线图 #2 三大目标**（ChatGPT 定调）：①精准定位（通知/审批卡/WebSocket 全部正确关联 permissionId 不串单）；②理解操作（按实际 permission payload 展示操作/命令/工作目录/影响，不凭空推断）；③防误操作（批准/拒绝明确区分，防误触/重复审批/过期审批）。流程要求：先审查现有 Permission 协议、后端审批流、手机端 UI，再定改造方案。

### 2026-11-12 路线图#2 目标① 精准定位（审批不串单）

- **现状审查结论**（动手前完成）：协议 `status:waiting{permissionId,permission,detail,patterns}` + `permission.reply` 回执 {replied,permissionId,decision}；v2 `permission.asked{id,action,resources,save,metadata,source,message}` 已映射；缺口——同 permissionId 重复询问堆叠多卡、`permission.replied` 被忽略（他人审批后卡片永久悬挂）、replyPermission 无幂等/无错误处理/不校验回执、深链只到会话不到具体审批项。
- **upsert 按 permissionId**：重复询问更新同一卡片（已决卡不改写），绝不堆叠/串单。
- **`permission.replied` 归位**：v2 映射为 `status:resolved{permissionId,decision}`（once→allow_once 等），手机端收到后立即定格对应卡片（他人/其他端审批不悬挂）。
- **审批幂等三防线**：已决卡拒绝重复提交、审批中防双击（in-flight 集合）、回执 `permissionId` 不一致视为串单风险不落定并提示重试。
- **深链直达审批项**：待审批通知 `clickUrl` 带 `?permission=<pid>`；`handleDeepLink` 解析并置 `focusedPermissionId`（UI 高亮目标卡，目标②③的展示基础）。
- 测试 +3（mobile 36：单卡 upsert/已决不改写/resolved 归位/回执失配不落定；opencode：permission.replied 映射）；全仓 243 vitest 全绿。

### 2026-11-12 路线图#2 目标① Round 2（审批状态 fail-closed 语义）

- **P0 未知决策不伪装**（两端）：mapper 只映射 once/always/reject，未知/缺失 decision → `unknown`（不默认 reject/allow_once）；手机端 `resolvedDecision='unknown'` 定格为「结果未知，等待电脑端状态同步」（无按钮）。
- **P0 严格回执**：`ok`/`data.replied`/`sessionId`/`permissionId`/`decision` 五项全等才落定；任一缺失或不匹配 → `resolutionUncertain` 不确定态（按钮不重新开放、禁止盲目重试），提示「审批结果暂时无法确认…请勿重复操作」，等待权威 resolved 事件同步。
- **P1**：in-flight 幂等键改 `(sessionId, permissionId)`（跨会话同 ID 不互相阻塞）；外部 resolved 事件同时清 `replyPending`/`resolutionUncertain`（他端审批后不再悬挂"提交中"）。
- **P2**：深链聚焦补 `focusedPermissionSessionId` 双键限定 + notifyListeners；通知 URL permissionId 编码/解析测试。
- 测试 +5（mobile 38：回执四态 fail-closed、决策映射四值、并发/归位四场景；opencode：unknown 映射；bridge-core：通知 URL 编码）；全仓 245 vitest 全绿。

### 2026-11-12 路线图#2 目标① Round 3（竞态与状态机收口）

- **P0 CI 修复**：push 测试 sender 回调返回类型（`async (m) => sent.push(m)` → block）。
- **P0 业务层禁重试**：`replyPermission` 对 `resolvedDecision != null || resolutionUncertain` 直接拒绝（状态机约束，不依赖 UI 隐藏按钮）——测试：不确定态二次调用 permissionReplies 仍为 1。
- **P1 状态优先级**（`_applyResolution`）：明确结果（allow/reject）终态不可覆盖/降级；unknown 可被后续明确结果升级、不被未知事件降级；RPC 异常仅在"尚无任何权威结果"时标记 resolutionUncertain——测试：权威 resolved 定格后迟到 RPC 异常不降级、RPC 成功不覆盖不同结果、unknown→allow_once 升级、明确态不被 weird 降级。
- **P1 竞态测试**：Completer 挂起 RPC→in-flight 中收到 resolved 定格→迟到异常/成功均不改写结论（真实 in-flight 模拟，非顺序 emit）。
- **P2**：回执缺字段逐项 fail-closed（ok=false / replied 缺 / sessionId 缺 / permissionId 缺 / decision 缺五种模式全测）；深链双键最终态断言（含 `perm%2F1%20x` 编码解析）；普通会话通知清除遗留审批聚焦。
- 测试：mobile 42（+4 大场景）、全仓 245 vitest + flutter analyze 全绿。

### 2026-11-12 路线图#2 目标② 理解操作（审批卡重构）

- **风险分级**（2.1，纯规则白名单，绝不推断影响）：`classifyPermissionRisk(action, resources)`——破坏性 action（delete/remove/write/edit/patch/move/kill/exec）或资源命中破坏性 token（rm/del/rmdir/unlink/mkfs/shutdown/reboot/kill 词边界）→高；命令类（bash/shell/run/terminal/process）→中；只读白名单（read/grep/glob/list/search/webfetch/websearch/fetch）→低；**其余一律「未分类」**（绝不默认判低）。优先级：高>中>低。
- **审批卡结构化展示**（2.2，仅按 payload）：头部「Agent 请求执行」+ 风险徽章（低/中/高/未分类，风险色）；操作行（action 原文）、请求详情（detail 原文 mono 可长按复制 SelectableText）、资源对象（patterns 逐行 mono）。工作目录/影响字段 payload 未提供则**不展示、不编造**。
- **深链聚焦高亮**：`focusedPermissionId` 命中的未决卡片蓝底 2px 描边（跨会话双键限定）。
- **通知正文升级**：待审批推送带操作类型（`请求 bash — <detail>`），锁屏即可读懂数量级。
- i18n 补 8 组文案（请求头部/操作/请求详情/资源对象/四档风险标签）4 语言。
- 测试：风险分级 7 断言（含"未识别绝不判低"与"破坏性 resource 优先级高于命令类"）+ 卡片渲染（结构化行/徽章/聚焦）；mobile 44、全仓 245 vitest 全绿。

### 2026-11-12 路线图#2 目标③ 防误操作（路线图 #2 收官提交）

- **拒绝/批准视觉分区**：拒绝独立红描边 OutlinedButton 靠左，批准组（允许一次 tonal、始终允许绿 FilledButton）靠右，间距拉开防误触。
- **44dp 最小触控**：三按钮统一 44 高（原 30）。
- **二次确认弹层**：allow_always **或** 高风险操作必须确认——弹窗展示「将永久允许：action」「生效资源：patterns」「影响后续同类请求」（allow_always 专属提示）/高风险警示，确认才提交、取消不动作。低风险 allow_once 直达（防审批疲劳）。
- **进行中禁用**：replyPending 期间按钮禁用（onPressed: null），收起动画（AnimatedSwitcher，`MediaQuery.of(context).disableAnimations` 时零时长尊重减弱动效）。
- **已决卡收起**：按钮区替换为结果行（对勾/叉/问号图标 + 文案），按决议着色。
- **超时提醒**：未决卡等待≥2 分钟显示橙色「已等待较长时间，请在电脑端确认当前状态」——**只报等待时长、绝不写"已过期"**（无服务端过期依据）；30s 周期刷新重建。
- i18n 补 8 组（确认标题/永久允许/生效资源/后续影响/高风险警示/确认/取消/等待提醒）4 语言。
- 测试：目标③整场景（低风险直达/allow_always 确认与取消/高风险确认/44dp 尺寸断言/已决收起/超时提醒文案）+ 大流程测试适配高风险二次确认；mobile 45、全仓 245 vitest 全绿。

### 2026-11-12 路线图#2 Round 4（目标②③边界收口）

- **二次确认交互矩阵**（P1）：reject 永远直达（拒绝是安全操作，不再被高风险误伤弹窗）；allow_always 必确认（弹窗含「将永久允许」+影响后续说明）；allow_once 仅高风险/未分类确认（弹窗文案独立为「仅本次允许以下操作」，不再复用永久允许文案）；低/中风险 allow_once 直达防审批疲劳。
- **detail 命令歧义契约**（P1）：detail 是 props.title 映射的描述性标题，**不参与风险分级**（不把自然语言当命令解析）；测试样例改为描述性文本并断言 bash=medium；未来若 Agent 提供结构化 command 字段再纳入规则。
- **风险词边界**（P2）：token 正则改「非字母数字边界 + caseSensitive:false」——`"rm -rf"`、`C:\tools\del.exe`、`foo,rm -rf`、`DEL something` 全命中，`model/`、`skill/` 不误判；token 集补 delete/deltree（最长匹配优先）。
- **超时计时起点**（P2）：waitingSince 改用请求真实产生时间——实时事件 `event.timestamp`、Snapshot `createdAt`（无效才 fallback now），历史恢复不重新起算、重复 waiting upsert 保留原起点。测试改为真实旧时间戳事件/快照断言（不再直接篡改字段）。
- P3：聚焦描边改独立蓝色 2px（与风险色解耦）+ decoration 断言；通知降级测试（有 action 无 detail 不编造命令、无 action 不拼空前缀）。
- 测试：mobile 47（+2）、bridge-core 77（+1）；全仓 246 vitest 全绿。

### 2026-11-12 路线图#2 Round 5（未分类/高风险概念区分，封板前最后一步）

- **弹窗标题按风险分级**：allow_always→「确认始终允许」；高风险 allow_once→「高风险警示」；**未分类（unknown）→独立文案「该操作尚未分类，无法确认其风险，请谨慎决定」**（4 语言），绝不用高风险文案冒充未分类。
- 测试：未分类 allow_once 弹框显示未分类警示、断言不出现高风险文案、取消不提交。mobile 47、全仓 246 vitest 全绿。

### 2026-11-12 路线图#2「权限审批人性化」整体验收通过（结项）

- ChatGPT 正式宣布：**路线图 #2 整体验收通过，不需要 Round 6，可封板**。终审确认三大设计原则已落实到代码/交互/测试：①风险不混淆（Unknown≠High，未知不伪装已知）；②安全操作不制造额外阻力（拒绝直达、低/中风险单次授权直达，仅高风险与未分类加确认）；③永久授权必须明确告知后果（影响范围与后续请求）。
- 路线图 #2 全程：目标①精准定位（三轮）、目标②理解操作、目标③防误操作 + Round 4 边界收口 + Round 5 概念区分，共 7 个 commit。
- 后续真实回归或新需求单独立项，不再反复修改已验收功能。

### 2026-11-12 路线图#3 状态安抚与「放心感」

- **顶栏状态胶囊**（3.1，`_StatusPill` 1s 计时刷新）：电脑在线/离线/连接中/**网络重连中（第 N 次）** + 会话活动态——「思考中 Ns」（status=running 时按 runningSince 计时）/「运行工具」（存在 pending/running 工具卡）/「等待审批」/「空闲」，连接态圆点着色。
- **断线重连语言**（3.2，非静默）：`BridgeConnectionState.reconnecting` 新状态 + `reconnectAttempt` 计数（成功清零）；断线后**保留会话视图**（不掉回配对页），顶部琥珀横幅「连接断开，正在重连（第 N 次）…期间消息自动补发」；4 次重试失败后转 disconnected 回配对页。
- **送达回执**（3.3，iMessage 心智）：`SendReceipt {pending, delivered, failed}`——发送中时钟图标、已送达电脑绿色双勾（Tooltip「已送达电脑」）、未送达红色警示（Tooltip「未送达，点击重发」+ 点击 `retrySendPrompt` **复用同一条消息重发**不新建）；失败同时保留错误卡。
- i18n 补 11 组（重连/思考中/运行工具/空闲/等待审批/横幅前后缀/断开/重试/已送达/未送达）4 语言。
- 测试：状态胶囊四态（Idle/Thinking 计时/重连第 N 次）、断线横幅补发语义、送达回执 pending→delivered→failed→重发达成；mobile 49（+2）、全仓 246 vitest 全绿。

### 2026-11-12 路线图#3 Round 2（状态机/补发语义/回执时机收口）

- **重连状态机修正**：`reconnectWithSavedCredential` 在 reconnecting 态不降级为 connecting/disconnected（重试全程保持 reconnecting + 递增计数），4 次失败后由外层转 disconnected 回配对页，成功清零 `reconnectAttempt`——修掉「一进入重试就掉回配对页」的真实缺陷。
- **补发语义改为可保证口径**：不做本地出站队列——断线/重连期间**发送按钮禁用**（UI + 客户端双守卫），横幅文案改「…断线期间的会话消息将在重连后自动同步」（历史消息重连后同步是可保证的，不谎称本地排队补发）。
- **送达回执语义统一**：delivered=「已送达电脑」（接受即确认，不等 Agent 执行完成）——CodexAdapter.sendMessage 改为 **spawn 成功即返回**（执行后台继续、完成/失败经事件流上报），新增 `waitForRun` 供测试/诊断等待；测试适配（sendMessage 后 waitForRun 再断言）。
- **Thinking 计时起点**：`runningSince` 取事件真实 timestamp（历史恢复不重新起算）、重复 running 事件不重置（`??=`）。
- **发送异常回执落定**：sendMessage 的 transport 异常捕获 → receipt=failed（不永久 pending）；retrySendPrompt 同守卫。
- 测试：4 次重试状态机（重试中保持 reconnecting/横幅在/失败后回配对页）、成功清零、断线禁发不出站、计时 300s 不重置、异常落定；mobile 52（+3）、全仓 246 vitest 全绿。

### 2026-11-12 路线图#3 Round 3（R3-1..R3-4 收口：重连恢复原子性/发送幂等/spawn 真确认/Adapter 语义统一）

- **R3-1 重连恢复原子性**：`connectionState=connected`+`reconnectAttempt` 清零推迟到 refreshAgents/refreshSessions/replayMissedEvents **全部成功之后**（hello 成功但恢复阶段失败保持 reconnecting，外层重试不被假 connected 重置）；身份校验失败路径同样尊重 `keepReconnecting`（自动重连失败≠手动配对失败，不再中途掉会话视图）。
- **R3-2 发送可靠性**：①`sendMessage` 改返回 `Future<bool>`（true=已接受）——所有发送入口（按钮/键盘 onSubmitted）**确认接受后才清空输入框和附件**（断线瞬间发送不丢消息）；②`BridgeRouter.sendMessage` 增加 `(sessionId, clientMessageId)` **幂等接受记录**：重复请求返回首次接受结果、进行中的复用同一 Promise、失败不缓存（允许真重试）、无 clientMessageId 不去重、LRU 512 上限——同一条 Prompt 重试不再双重执行。
- **R3-3 Codex spawn 真确认**：`CodexProcessHandle` 增加 `onSpawn`（Node 'spawn' 事件）——**确认进程真正启动成功才返回「已送达电脑」**（spawn 是异步确认，二进制不存在等在 error 事件才暴露，此前会假送达）；spawn 失败 reject + 规范化 error 事件（手机可见）；运行期异步失败同样发 error 事件（不再 `catch(()=>{})` 吞掉）；**非零退出码按失败处理并上报**（cancel 先置 cancelled 再 kill 不误报）。
- **R3-4 Adapter 送达语义统一**：claude-code/pi 从「等进程退出」改为与 codex 相同的**接受即返回**（spawn 确认 + 后台执行 + `waitForRun`）；同样具备 spawn 失败拒绝/错误事件/非零退出上报/cancel 判定；pi normalizer 暴露 `nextSequence`（runerr 事件与常规事件同一单调序号空间，防重复 sequence 被客户端误判重）；`AgentAdapter.sendMessage` 接口注释固化送达语义契约（spawn 型/RPC 型 acp/stdin 型 pty 全覆盖说明）。
- 测试：bridge-core 幂等 2（重复/并发/失败不缓存/无 ID 不去重）、codex spawn 失败假送达防护 + 非零退出 2、claude/pi mock 按 Node spawn 时序重构（setTimeout 分帧）+ waitForRun 断言、mobile 断线键盘发送不丢输入 + 重连中身份失败保会话视图 2（mobile 54）；全仓 251 vitest 全绿。

### 2026-11-12 路线图#3 Round 4（F1~F5 收口：草稿保护/幂等生命周期/终态反馈/ACP 双语义/进程串行化）

- **F1 草稿快照保护**：按钮与键盘两个发送入口在确认接受后仅当输入框文本+附件数与提交时快照一致才清空——延迟接受（spawn 确认/网络等待）期间用户继续编辑的新输入绝不被清掉（对照用例：不编辑则正常清空）。
- **F2 幂等缓存生命周期**：拆分 `sendInFlight`（执行中，**绝不淘汰**）与 `sendAccepted`（LRU 512，触达刷新）——512+ 突发流量不再把执行中的幂等记录挤掉导致重试二次执行；失败不缓存（允许真重试）。
- **F3 失败终态反馈闭环**：①三 adapter 的 `emitRunError` 同步发 **error + status:failed 双事件**（手机终止 Thinking 计时/置失败，不依赖后续 status）；②mobile `case 'error'` 也直接置 `_sessionStatusBySession=failed` + 清 `_runningSinceBySession`（防御性双保险）；③Codex `toAgentSession` 终态优先（record failed/cancelled 不被 normalizer 旧 running 遮蔽）；④**信号终止（exit code=null，非主动取消）按失败处理**并上报。
- **F4 ACP v1/v2 送达语义区分**：initialize 协商协议版本（优先 2，失败/回显 1 落 v1，幂等只发一次 initialize）——**v2：session/prompt 插入即返回 messageId=接受确认**（与统一契约一致）；**v1：响应=turn 完成，不谎称接受**——送达语义=已派发至 Agent 进程（与 pty stdin 同语义），turn 完成/失败经 status/error 事件上报；v2 `state_update`（running/requires_action/idle+stopReason）归约，`stopReason:error`→error+failed 事件。
- **F5 活动进程串行化**：codex/claude-code/pi 同一 session 同时只允许一个活动进程——并发第二条直接拒绝（防 activeProcesses/runs 覆盖导致进程失跟踪、无法取消）；mobile 键盘入口 `_isGenerating` 前置拦截。
- 测试：bridge-core in-flight 不淘汰（513 突发后重试只执行一次）、codex 并发拒绝 + 信号终止失败上报、acp v2 messageId 语义/v1 派发语义+失败上报/v2 state_update error、mobile 延迟接受不敷新输入（含对照）/error 终止 Thinking 计时（mobile 56）；全仓 257 vitest 全绿。

### 2026-11-12 路线图#3 Round 5（终局收口：附件身份快照/Claude-Pi 状态持久化/ACP v2 协议合规/启动占位）

- **F1 附件身份快照**：草稿快照从「附件数量」改为**身份列表 `path:name`**（数量相同内容不同也算被编辑）；新建 `AttachmentPicker` 网关（包装 file_picker，`debugOverrideFiles` 测试注入）。测试：延迟接受期间删 A 加 B（数量不变）→ 新附件与文本不被清空。
- **F3 Claude/Pi Session Record 终态持久化**：spawn 成功→`running`、正常完成→`idle`（claude 取 normalizer 状态）、异常/信号→`failed`、cancel→`cancelled`（先置再 kill）——`listSessions()` 返回真实终态，应用重启后不再回旧 idle；emitRunError 路径同步持久化。
- **F4 ACP v2 协议合规**：①initialize 携带 `info{name,title,version}`+`capabilities{}`，v2 响应读 `info.version`（agentInfo 为 v1 字段兼容读取）；②v2 恢复用 `session/resume`+`replayFrom:{type:'start'}`（v1 保留 session/load）；③v2 prompt 响应**缺 messageId 直接抛错**（拒绝假送达）；④`requires_action` 映射 `waiting`（不再当 running 显示 Thinking）；⑤initialize 回落 v1 仅在协议拒绝（错误带 code）时进行，传输层错误不盲目重试（legacy Agent 不支持重复初始化，由上层重建连接后重新协商）。
- **F5 await 前同步启动占位**：三 adapter `startingSessions:Set` ——检查+占位在任何 await 之前原子完成（封死 loadSession await 窗口双 spawn），spawn 后转入 `activeProcesses`、失败/取消均释放占位；cancel 一并清理占位。测试四场景（已加载并发/未加载并发/spawn 失败重发/cancel 后重发）× codex 全覆盖、claude/pi 并发拒绝+失败重发+未加载并发。
- 测试：mobile 57（+1 替换附件竞态）、acp 7（+3：缺 messageId/v2 resume/回落地形/requires_action）、codex 8、claude-code 3、pi 3；全仓 262 vitest + 11 typecheck 全绿。

### 2026-11-12 路线图#3 Round 6（F3-1/2、F4-1/2/3、F5-1/2 七项边界收口）

- **F3-1 运行期 error 持久化**：claude/pi（含 codex）运行期 `onError` 同步持久化 `record.status='failed'`，且**不再删除 activeProcesses**（删除会伪装成取消路径）——释放统一走 onExit；onExit 守卫「已 failed 不覆盖」。
- **F3-2 启动中取消持久化**：cancel 只要持锁（含 spawn 确认前窗口）即持久化 `cancelled`（不再限 status==='running'）；spawn 确认后发现取消意图→立即 kill+cancelled；spawn 前发现取消意图→不再 spawn+cancelled。
- **F4-1 错误码分类**：回落 v1 仅认 **JSON-RPC 数字错误码**中的版本/参数类（-32022/-32602/-32600）；网络错误（ECONNRESET 等字符串 code）与其余错误上抛（不盲目重复初始化）；v1 回落参数改 `clientInfo/clientCapabilities`（v1 形态）；测试断言回落参数 + ECONNRESET 不回落。
- **F4-2 v2 历史/工具归约**：`user_message(_chunk)`→text_delta role:user（历史用户消息不丢）、`agent_message(_chunk)`→role:assistant、`agent_thought` 并入、**tool_call_update 任意状态创建 tool_use**（每 toolCallId 一次，v2 无 tool_call）、`tool_call_content_chunk` 内容累积→tool_result 增量、终态覆盖累积。
- **F4-3 resume cwd**：`session/resume|load` 优先用会话已有 `projectPath`，不再一律传 defaultProjectPath；测试断言自定义工作目录。
- **F5-1/2 串行锁生命周期**：`sessionLocks` 从 sendMessage 入口同步加锁直到**真实 onExit** 才释放（kill≠已退出）；cancel 只设 `cancelRequested` 意图+kill，**不释放锁**——封死「kill 后 exit 前双进程」与「cancel 释放占位后并发 spawn」两个窗口；mock 按真实进程语义（exit 只发一次/异步 kill）。
- 测试：三 adapter「异步 kill 锁保持/启动中取消持久化+锁不释放/运行期 error 持久化」组合用例（codex 9、claude-code 4、pi 4）、acp 9（+4：错误码分类/历史归约/resume cwd/回落参数）；全仓 268 vitest + 57 mobile + 11 typecheck 全绿。

### 2026-11-12 路线图#3 Round 7（F4-1/F4-2 终局：ACP 真实 v2 数据结构 + 新连接回落）

- **F4-1 错误分类与连接生命周期**：回落 v1 **只认 -32022**（Unsupported protocol version）且按其 `data.supported` 结构化版本信息判断（不含 1 则不回落）；-32602/-32600/网络错误（字符串 code）一律上抛；**v1 回落必须走新连接**——新增 `AcpAdapterOptions.reconnect` 工厂，关闭原连接后在新连接上以 v1 形态（`clientInfo/clientCapabilities`）initialize（一个连接只协商一个协议版本）；无工厂则明确报错不重复初始化。测试：真 v1-only Agent 全流程（关闭旧连接/新连接 v1 initialize/prompt）+ supported 不含 1/网络错误/-32602/无工厂四类不回落。
- **F4-2 真实 v2 数据结构归约**：`extractText` 兼容 ContentBlock[]（数组）、ToolCallContent 对象（`{type:'content',content:{type:'text'}}`）、字符串降级；完整消息 `user_message/agent_message/agent_thought` 按 **messageId upsert 覆盖**（`full:true`，mobile text_delta/thinking_delta 支持 full=替换语义），`*_chunk` 按 messageId 追加；`tool_call_update.content`（ToolCallContent[]）**整体替换**工具内容、`tool_call_content_chunk.content`（单个 ToolCallContent）追加，终态覆盖；messageId/toolCallId 状态**按 Session 隔离**（`${sessionId}#${id}` key）。测试用官方 v2 真实 JSON 形态（content 数组/messageId/ToolCallContent 对象）覆盖 upsert 替换、chunk 追加、替换+追加混合、跨 Session 同名 toolCallId 隔离。
- 测试：acp 10（F4-A 全流程/不回落矩阵/真实结构归约）、mobile 58（+1 full upsert 覆盖语义）；全仓 269 vitest + 11 typecheck 全绿。

### 2026-11-12 路线图#3 Round 8（F4 终局：重连订阅/fail-closed/清空语义/diff 内容）

- **F4-1 新连接通知订阅**：抽取 `attachTransport()` 统一挂载（退订旧→挂新），初始连接与 v1 回落新连接都走它——修掉「v1 Agent initialize/prompt 成功但 session/update 全部丢失」的运行故障；dispose 正确退订。**fail-closed**：-32022 的 `data.supported` 缺失/非数组/不含 1 一律不回落（不得推测支持 v1）。
- **F4-2 清空语义**：消息 upsert 区分 **content 缺失=保留 / null、[]=清空 / 非空=替换**——清空下发 `full:true + delta:''` 事件，mobile 放行空 delta 的 full 覆盖（此前 `delta.isEmpty break` 吞掉清空）；tool_call_update 同样按**字段存在性**判断（null/[]=清空且 running 也发 tool_result）。
- **F4-2 diff/terminal 内容**：`extractText` 支持 `{type:'diff', changes, patch}`（变更摘要+patch.text）、`{type:'terminal'}` 明确标注不支持展示、未知扩展类型标注类型名——不再静默丢弃或假装提取成功。
- 测试：acp 11（新连接通知投递+dispose 退订/缺 supported fail-closed/清空语义矩阵/diff+terminal/字段缺失保留）、mobile 58（清空→fresh 增量）；全仓 270 vitest + 11 typecheck 全绿。

### 2026-11-12 路线图#4.1~4.3（时间线阅读性：Markdown 渲染/代码块复制/相对时间戳）

- **4.1 Markdown 渲染**：Agent 输出（StreamingTextItem 非思考）改用 `MarkdownMessage`（flutter_markdown + ExtensionSet.gitHubWeb）——标题/加粗/斜体/链接/行内代码/引用块/列表/分隔线全套样式对齐 design token（#141416/#686C75/#17B378）；围栏代码块=暗色容器（#17181C）+ 语言标签头 + `flutter_highlight`（atom-one-dark）语法高亮 + 横向滚动；用户气泡与思考过程保持纯文本（iMessage 心智/避免噪音）。
- **4.2 代码块复制按钮**：代码块头部 LucideIcons.copy 图标按钮（Tooltip「复制代码」4 语言），点击 `Clipboard.setData` 并短暂切换对勾反馈（1.5s 回退）——远程复制=核心动作。
- **4.3 相对时间戳**：UserPromptItem/StreamingTextItem 新增 `createdAt`（事件真实 timestamp/快照 createdAt/乐观=now），显示「刚刚/N 分钟前/N 小时前/N 天前/11月5日」（`NienieStrings.relativeTime` 4 语言 + 边界单测）；历史恢复不显示「刚刚」。
- 测试：4.1 Markdown 全结构渲染（标题/加粗/行内/代码块+HighlightView+语言标签）、4.2 复制写剪贴板+图标反馈回退、4.3 时间戳（乐观 just now/历史 3 min ago/边界矩阵含中文）；mobile 62（+4）、全仓 270 vitest 全绿。

### 2026-11-12 路线图#4.1~4.3 Round 2（时间边界/链接跳转/覆盖补齐）

- **4.3 时间三修**：45~59 秒归「刚刚」（不再出现 0 min ago）；未来时间戳（时钟偏差/事件乱序）归「刚刚」；**日期展示 `time.toLocal()`**（事件时间为 UTC ISO，UTC 午夜前后不错天，跨 UTC 午夜有测试）。
- **4.1 链接点击跳转**：`MarkdownMessage.onTapLink`——**仅放行 http/https**（javascript/file/ftp 拦截），默认 `url_launcher` 外部浏览器打开，`onOpenLink` 可注入（测试 spy）；依赖 `url_launcher`。
- **4.1 测试补齐**：斜体/链接/引用/列表/分隔线全覆盖 + 未知语言高亮降级（no-such-lang 仍渲染）+ 长行横向滚动容器；链接协议过滤专项测试（独立段落精确 tap）。
- **4.2 增强**：复制反馈改 Timer（连续点击不被旧计时器提前清掉）+ dispose 取消；多行代码剪贴板**完全相等**断言；围栏解析的尾换行去除（复制内容干净）。
- **依赖声明**：`markdown`（直接 import 的传递依赖收编为直接依赖）。
- 测试：mobile 64（+2）；全仓 270 vitest 全绿。
