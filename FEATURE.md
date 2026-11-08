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
- Nienie 官方网站上线与双端安装包分发（`website/index.html` & `https://nienie.quniv.cn`）：
  - 对齐 `openctrlc` 暖米白编辑感设计体系（`--page-bg: #f6f5f1`、`--page-ink: #1f2521`、自动深浅色模式与中英双语切换），无任何含用户隐私的真机截图
  - 构建 Android 发布版安装包（`Nienie-v0.1.0-android.apk`）与 macOS Apple Silicon 桌面客户端（`Nienie-v0.1.0-macos-arm64.zip`）并上传至京东云 MinIO（`https://file.quniv.cn/resource/nienie/`）
  - 官网托管于 **Cloudflare Pages**（`https://nienie-web.pages.dev`，`wrangler pages deploy`），双端安装包大文件则分发于京东云 MinIO（`https://file.quniv.cn/resource/nienie/`）；提供直链下载、短链重定向与手机浏览器扫码下载二维码

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
