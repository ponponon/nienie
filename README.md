# Nienie

Nienie 是一个移动优先的本地 AI 编程 Agent 控制台。

它让用户通过 iOS 或 Android 手机，远程查看和控制运行在 macOS、Windows 或 Linux 电脑上的编程 Agent。MVP 优先支持 OpenCode 和 Codex；后续继续扩展 Claude Code、Pi、OpenClaw、ACP Agent 以及其他本地 Agent，并通过统一事件模型在手机端重绘会话、工具调用、文件变更、状态和错误。

## 产品定位

```text
手机 Flutter App
        |
        | WebSocket
        v
Electron Desktop + Node.js Bridge
        |
        +-- OpenCode Adapter
        +-- Codex Adapter
        +-- Session Manager
        +-- Event Normalizer
        +-- Permission Router
```

Nienie 不是另一个模型服务，也不替代 OpenCode 或 Codex。Agent 继续使用用户电脑上的代码、工具链、账号和工作目录，Nienie 负责提供移动端控制界面。

公网连接默认使用可替换的 Relay：

```text
wss://nienie-replay.quniv.cn
```

用户可以在设置中换成自己的 Relay。默认 Relay 只用于方便测试和试用，不是强制的中心服务。

## MVP 范围

初版必须支持：

- Flutter 手机端，目标平台为 iOS 和 Android
- Electron 桌面端，目标平台为 macOS、Windows 和 Linux
- Electron 主进程内置 Node.js Bridge
- OpenCode 会话发现、创建、恢复、发送消息和实时事件
- Codex 会话启动、发送消息和结构化事件接收
- 手机端会话列表和会话详情
- 流式文本渲染
- 工具调用和工具结果卡片
- 基础状态、错误和用量事件
- 电脑端与手机端配对
- WebSocket 断线重连

初版明确不做：

- Claude Code、Pi、OpenClaw 等其他 Agent（后续阶段支持）
- 通用 ACP 适配器（后续阶段支持）
- PTY/TUI 终端兜底
- 完整远程桌面
- 云端账号和云端会话同步
- 多用户协作
- 复杂自动化编排
- 独立 Rust Bridge

## 技术路线

| 模块 | 技术 | 责任 |
|---|---|---|
| 手机端 | Flutter / Dart | 移动端 GUI、会话浏览、消息发送、事件展示 |
| 桌面端 | Electron / React / TypeScript | 配对界面、Bridge 状态、Agent 设置、日志 |
| Bridge | Node.js / TypeScript | 启动和连接本地 Agent，管理会话，转发事件 |
| OpenCode | OpenCode HTTP/SSE 或 SDK | 结构化会话和事件接入 |
| Codex | Codex 结构化运行接口 | Codex 会话和事件接入 |
| 手机-电脑通信 | WebSocket | 实时双向消息和事件传输 |
| 公网连接 | 可替换 WebSocket Relay | 电脑和手机都通过出站连接通信 |
| 协议 | JSON Schema 风格 JSON | 共享 DTO 和统一事件模型 |

## 目录

```text
apps/
  mobile/                 Flutter 手机端工程
  desktop/                Electron + React 桌面端工程

packages/
  protocol/               手机、桌面和 Bridge 的消息协议
  agent-events/           统一 Agent 事件模型
  bridge-core/            Node.js Bridge 核心服务
  agent-adapters/
    opencode/             OpenCode 适配器
    codex/                Codex 适配器

docs/
  architecture/          系统架构和数据流
  protocols/             通信协议和事件协议
  product/               产品定位和 MVP 约束

scripts/                  开发和验证脚本
```

## 开发原则

1. 手机端只依赖 Nienie 统一协议，不直接依赖 OpenCode 或 Codex 的原始格式。
2. 每个 Agent 使用独立适配器，禁止把 Agent 特殊逻辑散落到 Bridge 核心。
3. Bridge 逻辑与 Electron Renderer 解耦，后续可以拆成独立后台进程。
4. Agent 的 API Key、登录凭据和工作目录默认留在电脑端，不复制到手机。
5. 事件协议优先保证可重放、可调试和可版本化。
6. 能力不支持时必须通过 capability 明确表达，不能在 UI 中伪造按钮。

## 当前状态

项目已完成 MVP 全部闭环及第二/三阶段适配器扩展：

- 统一协议（`@nienie/protocol`）与事件归一化辅助层（`@nienie/agent-events`）
- Node.js Bridge 核心服务（`@nienie/bridge-core`）：RFC 6455 WebSocket 服务、一次性配对码与二维码鉴权、设备撤销、断线事件序号补发（`events.replay`）、`AES-256-GCM` 端到端加密公网 Relay 路由（`RelayServer` & `BridgeRelayClient`）、iOS/Android 推送通知路由（`PushNotificationRouter`）与 Linux 无 GUI 后台守护模式（`HeadlessBridgeDaemon`）
- Agent 适配器矩阵（`packages/agent-adapters/*`）：OpenCode（HTTP/SSE）、Codex（JSONL）、Claude Code（stream-json）、Pi（JSON RPC）、通用 ACP（JSON-RPC 2.0）、OpenClaw（HTTP）与 PTY/TUI 兜底适配器
- Electron 桌面端控制台（`apps/desktop`）与 Flutter 移动端应用（`apps/mobile`），支持运行 `pnpm verify` 一键完成跨端构建、静态分析与端到端闭环验证。

## 相关文档

- [架构总览](docs/architecture/overview.md)
- [MVP 范围](docs/product/mvp-scope.md)
- [Agent 适配器](docs/architecture/agent-adapters.md)
- [统一事件协议](docs/protocols/canonical-events.md)
- [手机端协议](docs/protocols/mobile-bridge.md)
- [公网 Relay](docs/architecture/relay.md)
- [功能记录](FEATURE.md)
- [失败经验](FailureExperience.md)

## 后续 Agent 路线

```text
MVP：OpenCode + Codex
第二阶段：Claude Code + Pi
第三阶段：ACP Agent、OpenClaw 和更多 JSONL/HTTP Agent
兜底：PTY/TUI Agent
```

每个阶段都必须复用统一事件协议，新增 Agent 只能增加适配器，不得把 Agent 特殊逻辑混入手机端或 Bridge 核心。
