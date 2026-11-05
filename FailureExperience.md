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

## 2026-11-04 后台残留进程占用 4100 端口导致用户执行 `pnpm start` 报 `EADDRINUSE`

### 问题

Agent 在后台通过 `nohup` 预启动了 `nienie-desktop.mjs`（占用 `4100` 和 `4101` 端口），随后用户在自己的终端执行 `pnpm start` 时，因端口已被旧实例占用而抛出 `Error: listen EADDRINUSE: address already in use 0.0.0.0:4100`。

### 根因

1. Agent 后台启动常驻进程后未考虑到用户会在交互终端手动执行 `pnpm start`。
2. `scripts/start-mac.mjs` 启动前未清理已存在的旧 `nienie-desktop.mjs` 实例。

### 影响

用户手动执行 `pnpm start` 直接报错退出，体验受阻。

### 修复

在 `scripts/start-mac.mjs` 启动前自动清理已存在的旧 `apps/desktop/dist/nienie-desktop.mjs` 进程，实现 `pnpm start` 幂等重启。

### 预防措施

本地开发启动脚本（如 `pnpm start`）必须具备幂等性：启动固定端口服务前应自动停止同项目的旧守护进程，或提供清晰的端口占用接管逻辑。

## 2026-11-04 `pnpm start` 仅启动命令行 HTTP 服务而未直接弹出 Electron 桌面 GUI 窗口

### 问题

用户执行 `pnpm start` 期望直接弹出 Electron 桌面应用 GUI 窗口，但初始启动脚本只用 `node` 启动了本地 HTTP/WebSocket 服务并打印浏览器 URL，没有直接拉起 `Electron.app` 原生 `BrowserWindow`。

### 根因

`apps/desktop` 初期仅实现了 HTML/IPC 逻辑而未引入 `electron` 运行时包与 `BrowserWindow` 主进程入口。

### 影响

用户运行桌面端启动命令时看不到原生桌面窗口，不符合 Electron 桌面应用的产品定位。

### 修复

1. 在 `@nienie/desktop` 中安装 `electron` 运行时并实现 `apps/desktop/src/electron-main.ts`（通过 `app.whenReady()` 与 `new BrowserWindow(createDesktopWindowOptions())` 启动原生桌面窗口）。
2. 将 `scripts/start-mac.mjs` 默认行为改为打包并拉起 Electron 原生 GUI 窗口（同时保留 `--headless` / `--smoke` 供无头服务与 CI 测试使用）。

### 预防措施

定位为 Electron 桌面端的应用，其默认启动命令（`pnpm start`）必须直接拉起真实的 Electron `BrowserWindow` 桌面界面，不得仅以命令行 Web URL 替代原生窗口。

## 2026-11-04 界面布局未按信息重要性置顶，次要长列表撑高首屏导致核心配对码需下滑查看

### 问题

1. 在桌面端控制台中，第一行左侧放了仅 3 行文字的「本地 Bridge」，右侧放了 7 个单列高卡片的「本机 Agents」（含 6 个未安装的 Agent），导致第一行被撑高至 450px+，左侧留下大片空白，而最核心的「手机扫码配对（二维码与 6 位配对码）」被挤到屏幕下半截并被截断，用户必须滚动下滑才能看到配对码。
2. 移动端与桌面端间距与卡片留白过于松散，未遵循紧凑、首屏核心功能免下滑的原则。

### 根因

布局时机械按模块顺序平铺，未做信息层级排序（Above-the-fold Priority），且未对多条目列表（7 个 Agent）做双列紧凑网格与在线优先排序。

### 影响

用户打开桌面端或手机端时无法在第一屏直接完成最高频的扫码/输入配对码操作，视觉重点失衡。

### 修复

1. 视觉风格统一升级为苹果 iOS/macOS + 微信清爽浅色风格（`#F2F2F7` / `#EDEDED` 分组浅灰底、`#FFFFFF` 纯白圆角卡片、`#07C160` 微信绿主操作按钮、右侧 `#95EC69` 用户消息气泡）。
2. 桌面端首屏重排：将最核心的「手机扫码配对」置于左上角第一视觉焦点，二维码与 26px 配对码紧凑并排；「本机 Agents」改为已安装优先排序的 2 列紧凑网格；次要的「运行日志」置于最底部。
3. 移动端首屏重排：「已保存的电脑」置顶一键重连，「WebSocket 地址 + 6 位配对码」同行并排，「二维码 URI 粘贴」压缩为单行，首屏无需下滑即可完成全部连接与会话操作。

### 预防措施

所有控制台与移动端页面设计必须遵循「首屏核心零滚动（Above-the-fold First）」原则：最高频操作（如配对码、重连按钮、会话流）必须置于首屏最上方；列表项超过 4 项时必须采用多列紧凑网格或在线优先折叠，严禁让未启用的次要项把核心操作挤出首屏。

## 2026-11-04 CSS Grid 缺失 `minmax(0, 1fr)` 与卡片 `min-width: 0` 导致长 URI 撑爆网格并出现横向滚动条

### 问题

将「手机扫码配对」移至桌面端双列网格左列后，包含 200+ 字符无空格 Base64 的 `nienie://pair?data=...` 文本且配置了 `white-space: nowrap`，因 `.workspace-grid` 使用了 `1.15fr 0.85fr` 且 `.card` 未设置 `min-width: 0`，导致左列被长字符串撑宽至 1400px+，右列被挤压成单字竖排窄条，整个窗口出现横向滚动条；用户向右横向滚动后，非固定顶栏随之左移，导致顶栏右侧的语言选择框与 macOS 左上角原生红黄绿按钮重叠。

### 根因

CSS Grid 中 `1fr` 等同于 `minmax(auto, 1fr)`，当子元素未声明 `min-width: 0` 且内部含有 `white-space: nowrap` 的超长无空格字符串时，网格轨道会按内容的固有最大宽度无限横向膨胀。

### 影响

页面出现严重的横向滚动、右列文字被挤压成竖排、横向滚动时顶栏控件与 macOS 红黄绿窗口按钮重叠。

### 修复

1. 将 `.workspace-grid` 列定义改为 `grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr)`，并为 `.card` 增加 `min-width: 0; overflow: hidden;`。
2. 为 `html, body` 增加 `max-width: 100vw; overflow-x: hidden;`，为 `.title-bar` 增加 `position: sticky; top: 0; z-index: 100;`。
3. 将右列「本地 Bridge」的三列小格子改为水平对齐的键值对行（`.kv-row`），避免窄宽度下文字竖排折行。

### 预防措施

任何包含长 URL、Base64、Token、路径或日志的 CSS Grid / Flex 容器，其轨道必须使用 `minmax(0, 1fr)` 且子项必须设置 `min-width: 0; overflow: hidden;`，根容器必须设置 `overflow-x: hidden` 严禁产生横向滚动条。

## 2026-11-04 桌面端二维码使用伪矩阵且手机端缺少摄像头扫码按钮，以及并排窄输入框导致占位符文字截断

### 问题

1. 手机端配对面板只有文本输入框而没有调用手机摄像头的「扫码连接电脑」按钮；且桌面端早期 `renderPairingQrSvg` 用 SHA-256 位图伪造了二维码图案，手机摄像头无法真实解码。
2. 手机端将「Bridge WebSocket 地址」和「一次性配对码 (6位)」两个输入框挤在同一行，导致小屏下右侧标签被截断为 `一次性配对...`；用户未填配对码误点连接时弹出原始英文异常 `Bad state: Invalid pairingCode or deviceName`。

### 根因

1. MVP 原型阶段用装饰性 SVG 代替了标准 ISO/IEC 18004 二维码编码，且未在 Flutter 侧集成 `mobile_scanner` 相机扫码组件。
2. 移动端表单将过长的中文字段标签放入半宽窄列中。

### 影响

用户无法在真机上直接调用摄像头扫描电脑屏幕二维码配对，且窄列标签截断与原始报错影响体验。

### 修复

1. 桌面端引入标准 `qrcode-generator` 生成真实可扫描的 QR Code SVG，并在监听 `0.0.0.0` 时自动将本机局域网 IPv4（如 `ws://192.168.x.x:4100`）写入二维码。
2. 手机端集成 `mobile_scanner` 与 Android/iOS `CAMERA` 权限，实现 `QrScannerSheet` 摄像头扫码弹窗，并在配对面板顶部置顶微信绿主按钮「扫码连接电脑」；扫码后若局域网 IP 因网络隔离不通，自动回退尝试 `ws://127.0.0.1:4100` USB 通道。
3. 手机端将「Bridge WebSocket 地址」改为独占一行，「一次性配对码 (6位)」与「配对并连接」同行，消除 `...` 截断，并将空配对码报错替换为四国语言友好提示。

### 预防措施

任何展示给用户的二维码必须使用标准 QR 编码器生成并支持真机摄像头扫描解码；移动端带长标签的输入框应独占一行或使用简短标签，严禁出现 `labelText` 被截断为 `...` 的情况。

## 2026-11-04 界面堆砌工程师后台参数（WebSocket URL、Base64 URI、未安装 Agent 列表与原始日志），缺乏苹果式“大道至简”渐进式披露

### 问题

桌面端与手机端将 `ws://127.0.0.1:4100`、`macbook_local`、`nienie://pair?data=eyJ...`、6 个未安装的扩展 Agent 以及原始运行日志全部平铺展示在首屏，视觉上像工程师调试后台而非面向大众的消费级产品。

### 根因

设计时按“所有功能同时平铺可见”的工程师思维排版，未使用渐进式披露（Progressive Disclosure）区分“普通用户 95% 场景只用的核心动作（扫码 / 输入 6 位数字）”与“5% 高级调试配置”。

### 影响

认知负荷过高，主次不分，破坏了苹果式简洁优雅的产品质感。

### 修复

1. **桌面端大道至简重构**：
   - 首屏居中单栏（最大宽度 600px），主卡片只展示「二维码 + 6 位配对码（`218 336`）+ 更换配对码 / 复制连接口令」，彻底隐藏 `nienie://pair?data=eyJ...` 原始字符串。
   - 「可用 AI 助手」卡片只默认展示已安装就绪的 Agent（如 `Codex · 已就绪`），未安装的 6 个扩展 Agent 默认收进 `查看其他未安装的助手 (6) ▾` 折叠抽屉。
   - 本地 Bridge 参数、公网 Relay 自定义地址与运行日志全部默认收进底部的 `高级设置与诊断日志 ▾` 折叠面板。
2. **手机端大道至简重构**：
   - 主卡片只保留「扫码连接电脑」绿色大按钮与「6 位配对码输入框 + 配对并连接」，将 `Bridge WebSocket 地址` 与 `粘贴二维码 URI` 默认收进底部的 `高级连接选项 ▾` 折叠区。

### 预防措施

面向用户的主界面必须遵循“大道至简（Distill & Progressive Disclosure）”原则：首屏只呈现用户完成核心目标所需的 1~2 个动作；所有 IP/端口、协议 URI、未启用的扩展项与诊断日志必须默认收进「高级选项」折叠面板中。
