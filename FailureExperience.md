# 失败经验

本文档记录开发过程中发现的错误、根因、影响和预防措施，避免同类问题重复发生。

## 记录格式

```markdown
## YYYY-MM-DD 标题

### 问题

### 根因

### 影响

### 修复

### 预防措施
```

## 当前记录

## 2026-11-04 宿主 Agent 环境变量污染 OpenCodeAdapter 默认认证配置

### 问题

在测试 `OpenCodeAdapter` Basic Auth 请求头时，适配器只传入了 `password: 'test-secret-password'`，预期默认用户名为 `'opencode'`，但实际发出的 Basic Auth 用户名变成了 `'openctrlc'`。

### 根因

`OpenCodeAdapter` 初始化时回退读取了通用的 `process.env.OPENCTRLC_SERVER_USERNAME`。当测试运行在 OpenCtrlC 宿主 Agent 进程内部时，宿主自身注入了 `OPENCTRLC_SERVER_USERNAME=openctrlc`，导致被测适配器的默认配置被宿主运行环境污染。

### 影响

在宿主 Agent 或多 Agent 嵌套环境中运行时，未隔离前缀的环境变量会导致 Bridge 错误携带宿主的认证用户名或密码去连接目标 OpenCode 实例。

### 修复

将 `OpenCodeAdapter` 的环境变量回退收敛为 Nienie 命名空间专属的 `NIENIE_OPENCODE_URL`、`NIENIE_OPENCODE_USERNAME` 和 `NIENIE_OPENCODE_PASSWORD`，不再隐式读取宿主进程的 `OPENCTRLC_*` 环境变量。

### 预防措施

所有 Agent 适配器的环境变量配置必须使用 `NIENIE_<AGENT>_*` 专属前缀或显式配置对象传入，禁止直接复用外部 CLI 自身的内部环境变量名。

## 2026-11-04 `flutter create` 自动注入本机 Apple Development Team ID

### 问题

在 macOS 开发机上执行 `flutter create . --platforms=ios,android` 生成 iOS 宿主工程时，Flutter 工具链会自动扫描本机钥匙串中的 Apple 开发者证书，并将个人 `DEVELOPMENT_TEAM` ID 写入 `ios/Runner.xcodeproj/project.pbxproj`，同时默认生成的 `analysis_options.yaml` 会引用未安装的 `package:flutter_lints/flutter.yaml`。

### 根因

Flutter CLI 默认开启了本机 iOS 签名身份自动探测与 `flutter_lints` 模板引用。

### 影响

1. 若直接提交 `project.pbxproj`，会将开发者个人的 Apple Team ID 泄露到公开仓库，且导致其他贡献者在无该团队证书时编译报错。
2. 未安装 `flutter_lints` 时会导致 `flutter analyze` 报 `include_file_not_found` 警告。

### 修复

1. 清理 `ios/Runner.xcodeproj/project.pbxproj` 中的 `DEVELOPMENT_TEAM` 字段。
2. 将 `apps/mobile/analysis_options.yaml` 改为零外部依赖的内置 `linter` 规则配置。

### 预防措施

每次生成或更新移动端原生宿主工程后，必须用 `grep` 检查 `DEVELOPMENT_TEAM` 与个人证书标识，并运行 `pnpm verify` 确认 `flutter analyze` 零警告通过。

## 2026-11-04 单个离线 Agent 导致 `AgentRegistry.listSessions()` 整体失败

### 问题

在本机仅安装了 `codex` 而未启动 `opencode serve`（`127.0.0.1:4096`）的环境下启动桌面端并拉取会话列表时，`OpenCodeAdapter.listSessions()` 抛出 `ECONNREFUSED 127.0.0.1:4096`，导致 `AgentRegistry.listSessions()` 中的 `Promise.all` 整体 reject，手机端无法看到任何其他在线 Agent 的会话。

### 根因

`AgentRegistry.listSessions()` 直接对所有已注册适配器调用 `Promise.all(adapters.map(a => a.listSessions()))`，未对离线适配器的连接拒绝异常做单适配器级降级隔离。

### 影响

只要任意一个已注册的 HTTP 类 Agent（如 OpenCode 或 OpenClaw）未启动，整个 Bridge 的 `sessions.list` 与 `machine.get` 接口都会返回失败。

### 修复

在 `AgentRegistry.listSessions()` 中对每个 `adapter.listSessions()` 增加 `.catch(() => [])` 故障隔离，确保离线适配器返回空数组而不阻断其他在线适配器的会话列表。

### 预防措施

聚合多个独立 Agent 适配器的查询接口（如 `detectAll`、`listSessions`）必须具备单适配器级容错隔离，绝不允许单个 Agent 离线拖垮全局列表查询。

## 2026-11-04 Flutter 移动端代码过度集中在 `lib/main.dart` 单文件（God File）

### 问题

在快速迭代 Flutter 移动端功能的过程中，将多语言字典、协议数据模型、时间线卡片模型、本地凭据存储、WebSocket/Relay 传输层、业务状态控制器与 UI 视图组件全部持续追加在 `apps/mobile/lib/main.dart` 单个文件中，导致该文件膨胀至 1300+ 行，违反了单一职责原则（SRP）与模块化工程实践。

### 根因

迭代新增移动端特性时贪图单文件修改便利，未在模块职责分化时及时按层拆分目录结构。

### 影响

单文件过大导致代码可读性下降、职责边界模糊、后续多人或跨 AI 协作维护困难。

### 修复

将 `apps/mobile/lib/` 按职责拆分为清晰的分层模块：
- `lib/main.dart`：仅保留 26 行薄启动入口与 barrel 导出
- `lib/src/i18n/app_strings.dart`：中/英/日/韩多语言字典
- `lib/src/models/protocol_models.dart`：统一协议 DTO
- `lib/src/models/timeline_items.dart`：会话时间线结构化卡片模型
- `lib/src/storage/credential_store.dart`：设备凭据存储（内存与文件持久化）
- `lib/src/transport/bridge_transport.dart`：直连 WebSocket、公网 Relay 与自动故障转移传输层
- `lib/src/state/mobile_bridge_client.dart`：状态管理与事件序号归并控制器
- `lib/src/ui/nienie_mobile_app.dart`：Flutter Material 3 视图组件

### 预防措施

任何入口文件（如 `main.dart`、`index.ts`）应只承担组合与导出职责；当单个源码文件承载超过 1 个领域职责或超过 400 行时，必须立即按 `i18n`、`models`、`storage`、`transport`、`state`、`ui` 分层拆分。
