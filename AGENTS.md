# Nienie Agent 指南

## 项目上下文

Nienie 是一个移动优先的本地 AI 编程 Agent 控制台。手机端使用 Flutter，电脑端使用 Electron，Bridge 使用 Electron 主进程中的 Node.js + TypeScript。MVP 只实现 OpenCode 和 Codex，后续要继续支持 Claude Code、Pi、OpenClaw、ACP Agent 以及其他本地 Agent。

项目目标是让用户通过手机查看、继续和控制运行在电脑上的 Agent，而不是重新实现 Agent 的模型调用和工具执行逻辑。

## 必读文档

- `README.md`：产品定位、技术路线和 MVP 范围
- `FEATURE.md`：已完成和规划中的功能
- `FailureExperience.md`：错误复盘和工程经验
- `docs/architecture/overview.md`：系统边界和数据流
- `docs/architecture/agent-adapters.md`：Agent 适配器约束
- `docs/protocols/canonical-events.md`：统一事件模型
- `docs/protocols/mobile-bridge.md`：手机和 Bridge 通信协议
- `docs/architecture/relay.md`：公网 Relay、隐私边界和可替换配置

## 目录边界

### `apps/mobile`

- 只负责 Flutter UI、移动端状态管理、本地安全存储和 WebSocket 客户端。
- 不直接解析 OpenCode 或 Codex 原始事件。
- 不保存电脑端 Agent 凭据。
- 所有会话消息和事件通过统一协议消费。

### `apps/desktop`

- 负责 Electron Renderer 中的桌面配置界面。
- 负责展示配对二维码、Bridge 状态、Agent 检测状态和日志。
- 不在 Renderer 中直接启动 Agent。
- 通过 Electron IPC 调用主进程 Bridge 能力。

### `packages/bridge-core`

- 负责 WebSocket 服务、会话管理、设备配对和事件广播。
- 只依赖适配器接口，不依赖具体 Agent UI。
- 任何 Agent 特殊逻辑必须放在 `packages/agent-adapters`。

### `packages/agent-adapters`

- `opencode`：OpenCode HTTP/SSE 或 SDK 适配。
- `codex`：Codex 结构化运行适配。
- 后续可增加 `claude-code`、`pi`、`openclaw` 和通用 `acp` 适配器。
- 适配器负责发现、启动、发送 Prompt、订阅事件、取消和恢复。
- 适配器必须把原始输出转换为统一事件。

### `packages/protocol`

- 存放手机、桌面和 Bridge 共享的协议类型、版本和校验逻辑。
- 协议变更必须更新版本号、样例和兼容性说明。

### `packages/agent-events`

- 存放统一 Agent 事件类型和归一化辅助逻辑。
- 不允许依赖 Flutter、Electron 或某个 Agent 的 SDK。

## Agent 适配原则

每个适配器至少需要明确：

- `id` 和展示名
- 运行时发现方式
- 启动方式
- Prompt 传输方式
- 原始事件格式
- 模型发现能力
- 会话恢复能力
- 取消能力
- 权限请求能力
- 统一事件映射规则

MVP 只实现 OpenCode 和 Codex。Claude Code、Pi、OpenClaw、ACP 和其他 Agent 属于后续路线，但在 MVP 阶段不要添加空适配器或未经验证的兼容声明。

## 安全原则

- 默认只监听本机或受控网络接口。
- 公网连接通过可替换 Relay，默认地址为 `wss://nienie-replay.quniv.cn`。
- 不得把默认 Relay 设计为不可替换的中心服务。
- 手机设备必须通过一次性配对码或二维码完成绑定。
- 每个设备使用可撤销的独立凭据。
- 不把 Agent API Key、CLI 登录凭据或完整环境变量发给手机。
- 所有远程执行、文件修改和权限操作都要有明确的事件记录。
- WebSocket 消息必须校验设备身份、协议版本和消息大小。
- 不允许通过手机协议直接执行未声明的任意桌面命令。

## UI 约束

- 手机端优先使用结构化卡片，不直接把 TUI 当主界面。
- 工具调用、文件变更、权限请求、错误和状态必须有独立视觉形态。
- 图标使用现有图标库或 SVG，不使用 Emoji 作为功能图标。
- 写 UI 前先调查同类组件的 DOM、样式、图标和 design token。
- 保持移动端触控目标、键盘避让、深色模式和断线状态可用。

## 变更记录要求

每次新增功能必须同步更新 `FEATURE.md`。

每次用户指出错误，或者发现具有长期预防价值的工程问题，必须将经验记录到 `FailureExperience.md`。

每次协议变更必须同步更新对应的 `docs/protocols/` 文档和样例。

## 验证要求

至少验证：

- Bridge 可以启动并发现 OpenCode/Codex
- 手机可以完成配对
- WebSocket 可以建立和恢复连接
- 文本流可以正确结束
- 工具调用和结果可以配对
- Bridge 重启后不会伪造旧会话状态
- 未授权设备不能发送 Prompt 或审批消息
