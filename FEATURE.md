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

## MVP 规划

- [x] Electron Bridge 启动和健康检查
- [x] OpenCode 适配器
- [ ] Codex 适配器
- [x] 手机与电脑二维码配对
- [x] 手机会话列表
- [x] 手机会话详情
- [x] 流式文本事件
- [x] 工具调用和工具结果事件
- [x] 基础状态和错误事件
- [x] 手机发送 Prompt
- [x] WebSocket 断线重连
- [ ] 公网 Relay 连接和设备路由
- [x] 自定义 Relay 地址配置
- [ ] Relay 端到端加密消息转发
- [ ] 基础权限请求展示

## 后续规划

- [ ] 文件变更和 Diff 卡片
- [ ] 模型选择和 Agent 能力展示
- [ ] 会话恢复
- [ ] 多台电脑管理
- [ ] ACP 适配器
- [ ] PTY/TUI 兜底模式
- [ ] 完整远程桌面兜底
- [ ] iOS 和 Android 推送通知
- [ ] Bridge 独立后台进程
- [ ] Linux 无 GUI 模式
- [ ] Rust Bridge 评估和迁移

## 后续 Agent 适配路线

- [ ] Claude Code 结构化流适配
- [ ] Pi RPC 适配
- [ ] 通用 ACP 适配器
- [ ] OpenClaw Gateway 适配
- [ ] 其他 JSONL / HTTP Agent 适配
- [ ] PTY/TUI 通用兜底适配
