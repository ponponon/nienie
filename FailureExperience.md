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

## 2026-11-04 立即执行按钮误加省略号 `...` 以及 `<select>` 未设 `appearance: none` 导致原生箭头贴边

### 问题

1. 在复刻微信输入法按钮样式时，机械地在「更换配对码...」「复制口令...」「重新检测...」等立即执行按钮后加上了省略号 `...`，导致用户误以为按钮文案因宽度不足被截断。
2. 「偏好与日志」页中的 `<select class="wetype-select">` 未声明 `appearance: none`，在 macOS Chromium 中保留了系统原生下拉箭头，导致右侧箭头紧贴右边框、内边距失调。

### 根因

1. 混淆了 macOS HIG 规范中“打开新模态窗口设置才加 `...`（如 `设置...`）”与“立即执行动作不加 `...`”的区分。
2. 自定义 `<select>` 边框与内边距时未重置浏览器默认 `appearance`。

### 影响

按钮文案看起来像溢出截断，且下拉框箭头紧贴边框破坏了精致感。

### 修复

1. 移除所有立即执行按钮后的 `...`，改为「图标 + 完整动作名」（如 `↻ 更换配对码`、`📋 复制连接口令`）。
2. 为 `.wetype-select` 设置 `appearance: none; -webkit-appearance: none; padding: 5px 28px 5px 12px;` 并内嵌微信输入法同款上下双箭头 SVG 背景图。

### 预防措施

1. 遵循 Apple HIG：仅当按钮点击后会打开二级弹窗等待用户补充输入时才允许使用 `...`，立即生效的操作按钮严禁加 `...`。
2. 所有自定义边框的 `<select>` 元素必须显式设置 `appearance: none`、右侧留足 `padding-right: 28px` 并配置自定义 SVG 指示箭头。

## 2026-11-04 设置行右侧硬塞宽输入框（`240px`）导致左侧标题与副标题被横向挤压折成 5 行

### 问题

在「跨设备网络」页的「自定义中继服务器」设置行中，采用了左右 `justify-content: space-between` 的单行布局，右侧同时放置了 `240px` 宽的 `<input>` 和「保存并应用」按钮，导致左侧仅剩约 `90px` 宽度，标题「自定义中继服务器」被折断成两行，副标题被折断成四行。

### 根因

在宽度有限（右侧内容区约 `480px`）的设置行中，试图将“长标题+长说明”与“长文本输入框+操作按钮”强行放在同一水平线上。

### 影响

左侧中文标题与描述文字严重挤压变形，阅读体验差。

### 修复

将带长文本输入框的设置行改为上下两层结构（`flex-direction: column; align-items: stretch;`）：
1. 上层完整展示单选圆点、单行标题与单行副标题，横向不再受输入框挤压。
2. 下层左缩进 `padding-left: 28px`（与标题文字左边缘对齐），让 `<input style="flex: 1">` 自适应填满剩余宽度并与「保存并应用」按钮同行并排。

### 预防措施

在设置列表行（Setting Row）中，右侧同一水平线只允许放置短控件（如 Toggle Switch、单个短按钮或宽度 ≤110px 的下拉框）；凡是包含 URL/路径等长文本输入框的设置项，输入框必须独立置于标题与说明文字的下一层并左对齐缩进。

## 2026-11-04 本机名称硬编码为 `macbook_local` 且不支持用户自定义修改

### 问题

桌面端启动入口将默认 `machineId` 硬编码为 `'macbook_local'`，在「偏好与日志」页仅只读显示 `macbook_local`，既未反映用户真实的电脑主机名，也不支持多台电脑场景下用户自定义命名。

### 根因

原型阶段使用了占位字符串 `'macbook_local'`，未对接 `os.hostname()`，也未在偏好设置中暴露重命名接口。

### 影响

当用户拥有多台电脑（如办公室 MacBook、家里台式机、Linux 服务器）时，手机端看到的机器标识千篇一律且无法按习惯自定义。

### 修复

1. 默认自动读取 `os.hostname().replace(/\.local$/i, '')`（如 `MacBook-Pro-M5`）。
2. 在 `DesktopBridgeController` 与 `PairingManager` 中实现 `setMachineName(name)` 与 `desktop:set-machine-name` IPC，在「偏好与日志」页提供自定义名称输入框与「保存」按钮，修改后同步刷新配对二维码并持久化至 `.nienie/desktop-preferences.json`。

### 预防措施

涉及设备/机器身份展示的字段，默认值应取自操作系统真实主机名（`os.hostname()`），并允许用户在偏好设置中自定义重命名与持久化。

## 2026-11-04 `pnpm start` 缺少源码监听与 UI 热更新（Hot Reload），导致每次修改界面需手动 `Ctrl+C` 重启

### 问题

在迭代桌面端 UI（`apps/desktop/src/renderer.ts`）的过程中，`scripts/start-mac.mjs` 只在进程启动时打包了一次静态产物，未开启源码文件监听与页面自动热刷新，导致每次修改完样式或布局后，用户都必须去终端按 `Ctrl+C` 再重新执行 `pnpm start` 才能看到最新界面。

### 根因

桌面端启动器只实现了单次构建拉起，未接入 `fs.watch` + 动态模块重载 + SSE 页面自动刷新机制。

### 影响

UI 迭代反馈链路割裂，每次微调都需要手动重启进程与窗口。

### 修复

1. 在 `scripts/start-mac.mjs` 中使用 `fs.watch` 递归监听 `apps/desktop/src/*.ts`，文件保存后 60ms 内通过 `esbuild` 重新编译 `apps/desktop/dist/renderer-live.mjs`。
2. 在 `DesktopPreviewServer` 中提供 `GET /api/hot-reload` SSE 流，监听 `renderer-live.mjs` 更新并向 Electron `BrowserWindow` 推送 `reload` 事件，前端通过 `EventSource` 自动调用 `window.location.reload()` 并借助 `sessionStorage` 保留当前激活的 Tab，同时动态 `import()` 最新 `renderer-live.mjs?t=<mtime>`，实现不断开 Bridge 连接、不关窗口的毫秒级无感热更新。

### 预防措施

所有 GUI 开发启动命令（如 `pnpm start`）必须默认开启文件监听与 UI 热更新（Hot Reload / Live Reload），避免要求用户在开发调试阶段反复手动重启进程。

## 2026-11-06 桌面端使用原始 HTML 字符串拼接与整页刷新导致界面呈现廉价感

### 问题

早期桌面端（`apps/desktop/src/renderer.ts`）未按照架构设计使用 React 与现代组件原语，而是直接手写 HTML 字符串拼接、简陋的原生 `<select>` / `<button>`，并在每次 IPC 调用后执行 `window.location.reload()` 整页刷新，导致视觉粗糙、交互生硬且伴随整页白屏闪烁。

### 根因

为图原型省事跳过了 React 19 组件化与成熟的无头 UI 组件库（Radix UI / shadcn 风格 + Lucide 图标库 + Sonner Toast），用静态模板字符串代替了响应式状态树。

### 影响

用户直观感受到桌面端 UI 粗糙劣质，下拉菜单、开关、弹窗与状态反馈缺乏现代 macOS 桌面应用应有的细腻质感。

### 修复

1. 在 `apps/desktop` 中引入 `react` 19、`react-dom`、`lucide-react`、`sonner` 及 `@radix-ui/react-tabs`、`@radix-ui/react-switch`、`@radix-ui/react-select`、`@radix-ui/react-collapsible`、`@radix-ui/react-dialog`。
2. 重构为 `DesktopApp.tsx` 响应式组件树，结合 `renderToString` SSR 首屏直出与 `/assets/desktop-client.js` 客户端激活。
3. 移除 `preview-server.ts` 中 IPC 调用后的 `window.location.reload()`，所有开关、语言切换、配对码刷新、Relay 配置与本机重命名均通过 React 状态在 0ms 内原地无感更新并触发 `sonner` Toast 反馈。

### 预防措施

桌面端与前端界面严禁使用原始 HTML 字符串拼接和 `window.location.reload()` 充当状态更新；必须使用 React + Radix UI / shadcn 原语 + 统一矢量图标库（Lucide / Phosphor）构建真正的响应式组件树。

## 2026-11-06 子页面 `min-height: calc(100vh - 48px)` 未扣除父容器上下内边距总和（`58px`）导致无故出现纵向滚动条

### 问题

在「升级和反馈」页面未展开折叠项、内容高度远小于窗口高度的情况下，右侧画布依然出现了一条几乎占满全高的纵向滚动条；同时应用图标 SVG 路径误写成了五笔折线（显示为字母 `M` 而非 `N`）。

### 根因

1. 外层 `.wetype-shell` 有上下 `padding: 12px`（共 `24px`），内层 `.wetype-main` 有 `padding-top: 10px; padding-bottom: 24px;`（共 `34px`），两层容器垂直内边距总和为 `24 + 34 = 58px`，而 `.about-pane-inner` 设置了 `min-height: calc(100vh - 48px)`，比可用内容高度多出了 `10px`，触发了 `.wetype-main` 的 `overflow-y: auto` 滚动条。
2. SVG 折线坐标写成了 `M15 33V17L25 29.5L35 17V33`（5 个顶点的 `M`），而非 4 个顶点的 `N`（`M17 33V17L33 33V17`）。

### 影响

页面明明内容很少却挂着一条多余的滚动条，破坏了桌面原生设置界面的精致感。

### 修复

1. 将 `.about-pane-inner` 的 `min-height` 修正为 `calc(100vh - 64px)`（小于 `100vh - 58px` 可用净高），消除静态溢出滚动条，同时保持底部版权区 `margin-top: auto` 贴底。
2. 将应用图标 SVG 路径修正为标准字母 `N`（`M17 33V17L33 33V17`）。

### 预防措施

在使用 `calc(100vh - Xpx)` 计算子容器 `min-height` 时，必须精确累加所有祖先容器的上下 `padding` + `border` 总和并留出安全余量，严禁凭感觉估算扣除值导致产生几像素的幽灵滚动条。

## 2026-11-06 使用通用符号图标（`>_`、`</>`、`⌘`）代替各 AI Agent 真实官方品牌 Logo

### 问题

在「本机 AI 助手」列表中，为 Codex、OpenCode、Claude Code、Pi、ACP、OpenClaw 等具体 AI 产品使用了 `lucide-react` 的通用符号图标（如 `Terminal`、`Code2`、`Command`），导致多个不同 Agent 显示相同的 `⌘` 符号，缺乏品牌辨识度与真实产品感。

### 根因

直接从通用 UI 图标库（Lucide）中找近义符号充当品牌 Logo，而未引入专门的 AI 品牌图标库（`@lobehub/icons-static-svg`）及本地开源仓库（`/Users/ponponon/Desktop/code/me/github/opencode`）中的官方品牌 SVG。

### 影响

用户一眼看出图标不是真实的 Agent 官方 Logo，显得山寨且难以快速区分不同 Agent。

### 修复

1. 引入 `@lobehub/icons-static-svg` 并提取官方品牌矢量图标：
   - **Codex**：使用 `@lobehub/icons-static-svg/icons/codex-color.svg`（OpenAI Codex 官方蓝紫渐变云朵终端标志）
   - **OpenCode**：使用 `/Users/ponponon/Desktop/code/me/github/opencode` 官方仓库中的双色几何方块 Logo（`opencode-logo-light-square.svg`）
   - **Claude Code**：使用 `@lobehub/icons-static-svg/icons/claudecode-color.svg`（Anthropic Claude Code 官方陶土橙像素标志）
   - **OpenClaw**：使用 `@lobehub/icons-static-svg/icons/openclaw-color.svg`（OpenClaw 官方红色龙虾标志）
   - **Pi**：使用 `@lobehub/icons-static-svg/icons/pi.svg`（Pi 官方几何字母标志）
   - **ACP Agent**：使用 `@lobehub/icons-static-svg/icons/mcp.svg`（协议互联标志）
2. 将图标底框改为纯白圆角应用图标底座（`.agent-brand-box`），避免底色污染官方品牌本色。

### 预防措施

凡是展示具体第三方产品、AI 模型或编程 Agent（如 OpenCode、Codex、Claude Code、OpenClaw、Pi 等），必须使用 `@lobehub/icons-static-svg`、`simple-icons` 或官方仓库中的真实品牌 SVG Logo，严禁拿通用 UI 图标（如 `⌘`、`</>`、星星）敷衍代替。

## 2026-11-06 手机端「高级连接选项」中将长 URI 输入框与宽操作按钮塞在同一水平 `Row` 导致互相挤压遮挡

### 问题

在一加真机屏幕上，展开「高级连接选项」后，下方的 `TextField(input-qr-uri)`（占位符 `或粘贴配对二维码 URI (nienie://pair?data=...)`）与右侧 `OutlinedButton("使用二维码 URI 配对")` 被放在同一个水平 `Row` 内且无间距，由于按钮文字较长占去近一半宽度，导致左侧输入框文字被截断为 `或粘贴配对二维码 URI (n...` 并与右侧按钮边框紧贴遮盖。

### 根因

在宽度仅约 360dp 的移动端卡片内，违反了「长文本输入框严禁与宽按钮同行并排」以及 `design-taste-frontend` 规范中的「Label ABOVE input（标签在输入框上方、严禁用长 placeholder 充当唯一标签）」原则。

### 影响

移动端输入框可编辑区域只剩不到一半宽度，占位符与按钮视觉互相挤压遮盖。

### 修复

1. 将「高级连接选项」中的 `Bridge WebSocket 地址` 与 `或粘贴配对二维码 URI` 全部改为标准的上下堆叠结构：上方为 `12.5px` 独立标题标签，中间为带 `#F6F7F9` 浅灰圆角边框的 100% 全宽输入框（`nienie://pair?data=...`），下方为独占一整行的全宽按钮「使用二维码 URI 配对」。
2. 精简首屏「扫码连接电脑」副标题文案为 `对准电脑二维码即可自动配对`，使其在手机屏宽度下完整单行展示不折行。

### 预防措施

在移动端（宽度 < 480dp）表单设计中：
1. 必须遵循「Label ABOVE Input」原则，严禁把 20 字以上的长说明塞进 `hintText` / `placeholder`。
2. 凡是 URL / URI / 路径输入框或文字超过 4 个字的按钮，必须采用纵向堆叠的全宽布局（Full-width Stacked），严禁把长输入框和宽按钮挤在同一水平 `Row` 中。

## 2026-11-06 本机已安装 `opencode` 却显示「未安装」，且手机端向 `Codex` 发送对话后无响应

### 问题

1. 用户电脑已安装 `/Users/ponponon/.bun/bin/opencode`（`1.19.5`），但桌面端与手机端均显示 `OpenCode` 为「未安装」（不可用灰点）。
2. 用户在手机端连接后向 `Codex Workspace` 发送对话，长时间收不到任何回复。

### 根因

1. **OpenCode 仅探测了 HTTP 端口而未自动拉起服务**：`OpenCodeAdapter.detect()` 仅请求了 `http://127.0.0.1:4096/global/health`，未检查 `~/.bun/bin/opencode` CLI 是否存在，也未在 `4096` 端口未启动时自动执行 `opencode serve --pure --port 4096 --hostname 127.0.0.1`。
2. **Codex 子进程缺失 macOS 系统代理环境变量**：`codex exec` 使用 Rust `reqwest`/WebSocket 直连 OpenAI，不会自动读取 macOS 的 `scutil --proxy` 系统代理设置。当用户未在终端手动 `export https_proxy` 时，`codex exec` 因直连被墙报 `Connection reset by peer (os error 54)` 并陷入 5 次重连超时。
3. **手机端输入框缺失 `onSubmitted` 回调**：Flutter `TextField(input-session-prompt)` 未配置 `textInputAction: TextInputAction.send` 与 `onSubmitted`，导致用户按手机输入法键盘右下角的「发送/回车」键时不会触发 `client.sendMessage()`。

### 影响

用户本机明明安装了 OpenCode 却无法使用，且在手机端发消息给 Codex 无响应。

### 修复

1. **`OpenCodeAdapter` 自动发现与自启动**：自动搜索 `~/.bun/bin/opencode`、`~/.local/bin/opencode`、`/opt/homebrew/bin/opencode`，当 `127.0.0.1:4096` 未监听时自动后台拉起 `opencode serve --pure --port 4096 --hostname 127.0.0.1` 并等待 `/global/health` 就绪。
2. **`CodexAdapter` 自动注入 macOS 系统代理**：在 `darwin` 平台下通过 `scutil --proxy` 自动读取已启用的系统代理（如 `http://127.0.0.1:10902`）注入 `codex exec` 子进程的 `http_proxy` / `https_proxy` 环境变量。
3. **手机端软键盘发送支持与 Agent 快速切换**：为 `input-session-prompt` 补齐 `TextInputAction.send` 与 `onSubmitted` 回调，并支持点击顶部 Agent 芯片直接切换到对应 Agent 的会话。

### 预防措施

1. 依赖本地 HTTP 守护进程的 CLI Agent（如 OpenCode），适配器必须在检测到 CLI 二进制存在但端口未监听时自动拉起后台 `serve` 进程，严禁要求用户手动去终端先跑一个守护进程。
2. 在中国大陆开发环境下，桌面主进程 spawn 任何需访问外网 API 的 CLI 工具（如 `codex`、`claude`）时，若环境变量未显式配置代理，必须自动从 `scutil --proxy` 读取系统代理并注入子进程 `env`。
3. 移动端所有聊天/指令输入框必须同时支持「右侧发送按钮点击」与「软键盘 `TextInputAction.send` + `onSubmitted` 回车发送」。

## 2026-11-06 未扫描 `~/.nvm/versions/node/*/bin` 导致漏检已安装的 Claude Code，且将底层协议（`ACP Agent` / `PTY`）误当作独立 AI 产品展示

### 问题

1. 用户电脑已通过 npm 在 `~/.nvm/versions/node/v22.17.1/bin/claude` 安装了 `Claude Code v2.1.169`，但因当前默认 Node 版本为 `v22.23.1`，`ClaudeCodeAdapter` 仅按当前 `PATH` 查找 `claude`，误报 `Claude Code`「未安装」。
2. 桌面端「本机 AI 助手」列表把架构底层的通用协议适配器 `ACP Agent` 和终端兜底器 `PTY Terminal Fallback` 与 OpenCode、Codex 等真实产品并列展示，导致用户困惑（“我都没听说过”）。

### 根因

1. macOS 开发者常使用 `nvm` 管理多个 Node 版本，全局 npm CLI 可能安装在非当前激活的 Node 版本 `bin` 目录下；仅依赖当前进程 `PATH` 会漏检其他 nvm 版本下的 CLI。
2. 混淆了「面向用户的 AI 助手产品（OpenCode、Codex、Claude Code、MiMo Code、DeepSeek Harness）」与「内部底层通信协议/兜底机制（ACP、PTY）」。

### 影响

用户本机已安装的 Claude Code 无法被识别，且界面上出现了用户无法理解的内部协议名称。

### 修复

1. 在 `ClaudeCodeAdapter` 与 `DshAdapter` 中增加对 `~/.nvm/versions/node/*/bin` 及 `/Applications/*.app/Contents/Resources/runtime/cli/bin` 的自动扫描，自动发现本机已安装的 `Claude Code v2.1.169`、`MiMo Code v0.1.0` 与 `DeepSeek Harness v0.2.1-rc.5`。
2. 默认不在面向用户的「本机 AI 助手」列表中注册 `ACP Agent` 与 `PTY Terminal Fallback`，仅展示真实的 AI 编程助手产品。

### 预防措施

1. 在 macOS/Linux 上探测 Node 生态 CLI 工具时，除常规 `PATH`、`~/.bun/bin`、`/opt/homebrew/bin` 外，必须遍历 `~/.nvm/versions/node/*/bin` 以兼容多 Node 版本环境。
2. 面向用户的 UI 列表只允许展示真实可感知的软件产品名称与官方 Logo，严禁把内部抽象协议层（如 ACP、PTY Fallback、JSON-RPC）直接暴露在产品列表中。

## 2026-11-06 一次性配对码被消费或满 5 分钟过期后桌面二维码未自动轮换，导致再次扫码报 `Pairing code is invalid or expired`

### 问题

用户在手机端扫码连接或重启 `pnpm start` 后再次扫码，出现 `Bad state: Pairing code is invalid or expired`（配对码 `693061` 失效）。

### 根因

1. **一次性配对码消费后桌面未自动刷新二维码**：`PairingManager.confirmPairing()` 采用严格的一次性消费策略（验证通过后立即 `this.pendingCodes.delete(code)`），但未通知 `DesktopBridgeController` 生成新配对码，导致桌面窗口上继续展示已经被用掉的旧二维码。
2. **默认 5 分钟 TTL 过短**：`DEFAULT_PAIRING_TTL_MS` 仅设了 5 分钟（`693061` 在 `16:06:08` 生成、`16:11:08` 过期），桌面窗口常驻超过 5 分钟后二维码即静默失效。
3. **`pairWithQrUri` 的 `catch (_)` 范围过大**：移动端 `pairWithQrUri` 将整个 `pairAndConnect` 包在 `try/catch` 中，若局域网建连并消费了配对码后后续步骤抛错，又去 `127.0.0.1` 用同一个一次性配对码发起第二次 `pair.confirm`，必然报配对码无效。
4. **`DesktopBridgeController` 未向 `PairingManager` 传入 `persistenceFilePath`**：导致每次 `Ctrl+C` 重启 `pnpm start` 后，之前已配对手机的 `deviceToken` 记录丢失。

### 影响

用户只要扫过一次码，或者桌面窗口开着超过 5 分钟，再拿手机扫屏幕上的二维码就会报 `Pairing code is invalid or expired`。

### 修复

1. 在 `PairingManager` 中增加 `onDevicePaired` 事件回调，当配对码被消费时，`DesktopBridgeController` 自动立即调用 `refreshPairingCode()` 生成新二维码，且桌面端 React 组件每 2.5s 自动同步最新状态。
2. 将 `DEFAULT_PAIRING_TTL_MS` 提升至 24 小时，并为 `DesktopBridgeController` 的 `PairingManager` 传入 `.nienie/paired-devices.json` 持久化路径。
3. 缩小移动端 `pairWithQrUri` 的回退捕获范围：仅当 `transport.connect(wsUrl)` 网络连接本身失败时才回退尝试 `127.0.0.1`，绝不在 `pair.confirm` 之后重复提交一次性配对码。

### 预防措施

凡是采用「一次性消费（One-time Token/Code）」机制的二维码界面，服务端在 Token 被消费或过期的瞬间必须自动生成新 Token 并推送给 UI 刷新二维码，严禁在屏幕上继续展示已核销作废的旧二维码。

## 2026-11-06 手机端主屏顶部堆砌三层横条导致界面拥挤不专业，且未按「电脑 → Agent → 项目空间 → 会话」层级组织

### 问题

1. 早期手机端在主对话页顶部同时堆叠了「AppBar + Agent 芯片横条 + Session 卡片横条」三层带边框容器，占去近 150px 高度，底部输入栏又被左侧三个大图标挤压，整体显得杂乱、业余。
2. 所有会话扁平混排，未按用户电脑上各 Agent 真实打开的项目文件夹（`空间 / Workspaces`）分组展示，也未读取 `~/.codex/state_5.sqlite`、`~/.claude/projects`、`GET /project` 中的本地历史项目与会话。

### 根因

1. 把原本属于侧滑抽屉（Drawer）和底部双层胶囊输入栏（Composer Capsule）的导航与切换控件全部平铺塞进了主屏顶栏。
2. 适配器 `listSessions()` 仅返回当前内存新建的会话，未对接各 Agent 本地持久化存储（如 Codex 的 `state_5.sqlite`、OpenCode 的 `/project` + `/session`）。

### 影响

手机端视觉粗糙拥挤，且用户连接电脑后看不到各 Agent 已经打开过的项目工作区和历史会话。

### 修复

1. 参考 `/Users/ponponon/Desktop/code/me/github/kelivo` 源码（`home_mobile_layout.dart`、`chat_input_bar.dart`、`side_drawer.dart`），先绘制 3 屏高保真原型图经用户确认后实施：
   - 顶栏改为 Kelivo 同款长短双横线按钮 + 双行无框标题（会话名 + `项目 · Agent (电脑名) ▾`）。
   - 底部改为 `R22` 双层圆角胶囊输入舱（上层全宽输入，下层左放 Agent 彩色图标胶囊与工具按钮、右放圆形发送按钮）。
   - 对话流改为无外框通栏正文 + `#F7F8FA` 紧凑工具胶条。
2. 实现 `KelivoWorkspaceDrawer` 三级侧滑抽屉（`电脑切换` → `Agent 切换` → `空间 (N)` 项目文件夹树 + 项目下历史会话 + 文件夹右侧 `+` 新建该项目会话），并在 `CodexAdapter`、`OpenCodeAdapter`、`MiMoCodeAdapter`、`ClaudeCodeAdapter`、`DshAdapter` 中接入本机真实项目与历史会话读取。

### 预防措施

1. 移动端对话主界面必须保持极简：顶栏最多一层（双行标题），底部输入区采用上下双层圆角胶囊（文字输入层与工具图标层分离），绝不允许在主界面顶部堆砌多层横向滚动的筛选条。
2. 进行大幅度 UI 重构前，必须先参考标杆开源项目（如 Kelivo）的组件结构绘制高保真原型图与用户对齐，确认后再动手写代码。

## 2026-11-06 硬编码 `~/.codex/state_5.sqlite` 忽略了 Codex 按主 Schema 版本号递增数据库文件名的机制

### 问题

用户指出 `~/.codex/state_5.sqlite` 文件名末尾带有 `_5`（同理还有 `logs_2.sqlite`、`goals_1.sqlite`），询问未来 Codex 升级后是否会变成 `state_6.sqlite`、`state_7.sqlite`...，而 `CodexAdapter` 最初直接硬编码了 `'state_5.sqlite'`。

### 根因

Codex 客户端在遇到破坏性 SQLite Schema 演进时，会将主 Schema 版本号拼接到文件名中（`state_<version>.sqlite`）。硬编码固定数字 `_5` 会导致未来 Codex 升级到 `_6`、`_7` 后只读到旧库甚至漏读新会话。

### 影响

当用户升级 Codex 后，新产生的项目和会话写入了 `state_6.sqlite`，硬编码 `state_5.sqlite` 会导致历史列表停留在旧版本数据。

### 修复

在 `CodexAdapter` 中实现 `resolveLatestCodexStateDb(codexDir)`：自动扫描 `~/.codex` 目录下所有匹配 `/^state(?:_\d+)?\.sqlite$/` 的数据库文件，按提取出的数字版本号 `schemaVer` 降序（如 `10 > 6 > 5`）及文件最新修改时间 `mtimeMs` 排序，动态选取最新版本的 `state_*.sqlite`。

### 预防措施

凡是对接第三方工具本地数据库或缓存文件，若文件名包含数字后缀（如 `state_5.sqlite`、`v2.db`），严禁硬编码具体数字，必须通过正则匹配并按数值版本号（注意用 `Number()` 而非字典序，确保 `10 > 9`）与 `mtimeMs` 动态选取最新文件。

## 2026-11-06 误用仅按当前目录过滤的 `GET /session` 接口并伪造「xxx 默认会话」占位符，导致 OpenCode 与 MiMo Code 漏读跨项目真实历史对话

### 问题

用户指出手机端在切换到 `OpenCode` 和 `MiMo Code` 时，项目列表下显示的都是 `Test`、`MiMo Code Workspace` 或 `openctrlc 默认会话`、`ideaboom 默认会话` 等假名字，而在小米 MiMo 桌面客户端里明明有 `Code Review 提交 b445d68d`、`查看并修复这个问题`、`检查resume.md错别字与逻辑问题并给出改进意见`、`孤悬进程排查：是什么？谁启动的？`、`查询我持有的域名` 等真实对话标题。

### 根因

1. **OpenCode 与 MiMo Code 的 `GET /session` HTTP 接口默认按当前 `directory`（即 `nienie` 目录）过滤**：当服务在 `nienie` 目录下启动时，`GET /session` 只返回了 `nienie` 目录下的测试会话（`Test`），而把 `openctrlc`、`resume`、`ideaboom`、`taisan_console` 等其他项目下的真实历史会话全部过滤掉了。
2. **错误地用 `${folder} 默认会话` 兜底填充**：因为 `GET /session` 没返回其他项目的会话，代码错误地为 `GET /project` 中的每个项目伪造了一条 `${folder} 默认会话` 占位记录。
3. **DeepSeek Harness (`dsh`) 未读取 `session_projcache`**：`dsh` 的真实对话标题保存在 `~/.dsh/storages/session_projcache/sessions/<sessionId>.json` 的 `record.rows.title.val` 字段中，而非文件夹名。

### 影响

用户在手机端看不到 OpenCode、MiMo Code 与 DeepSeek Harness 各项目下真实的过往对话标题，取而代之的是无意义的「默认会话」占位符。

### 修复

1. **`OpenCodeAdapter` 与 `MiMoCodeAdapter` 直接读取全量 SQLite `session` 表**：通过 `sqlite3 -json` 查询 `~/.local/share/opencode/opencode.db` 与 `~/.local/share/mimocode/mimocode.db` 的 `SELECT id, title, directory, time_created, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 120`（排除 `parent_id IS NOT NULL` 的子代理内部调用），并在 `loadSession` / `sendMessage` 时携带对应会话真实的 `directory` 参数。
2. **`DshAdapter` 对接 `~/.dsh/storages/session_projcache/sessions/*.json`**：读取真实的 `record.rows.title.val` 与 `record.identity.cwd`。
3. **彻底删除所有 `${folder} 默认会话` 伪造逻辑**，并清理调试期间写入数据库的 `Test` 垃圾会话。

### 预防措施

严禁在任何适配器中伪造「xxx 默认会话」等假数据掩盖数据读取不全的问题；当发现某个项目下没有真实会话标题时，必须排查底层 SQLite 数据库（如 `opencode.db`、`mimocode.db`、`session_projcache`）是否因 `directory` 过滤参数而漏读。

## 2026-11-06 切换 Agent 筛选时误写「为空则回退全量列表 / 不清空旧状态」导致未安装的 Pi / OpenClaw 显示上一个 Agent 的项目列表

### 问题

用户本机未安装 `Pi` 和 `OpenClaw`，但在手机端抽屉切换到 `Pi` 或 `OpenClaw` 时，下方依然显示了 `OpenCode` 的 `空间 (20)`（`openctrlc`、`ideaboom` 等会话列表），而不是空白列表。

### 根因

1. `projectsForAgent()` 中错误地写了 `final source = filtered.isNotEmpty ? filtered : sessions;`——当按 `targetAgent` 过滤出的 `filtered` 为空时，竟然回退去取了全量 `sessions`（即其他 Agent 的会话）！
2. `selectAgent()` 中写了 `if (matching != null) { activeSession = matching; }`——当新切换的 Agent 没有任何会话（`matching == null`）时，没有将 `activeSession` 置空，导致 `activeSession` 残留着上一个 Agent 的会话。
3. `loadModels()` 中使用了 `selectedModelId ??= ...`——当从有模型的 Agent 切换到另一个 Agent 时，因为 `selectedModelId` 非空而保留了旧 Agent 的模型 ID。
4. `disconnect()` 时未清空 `agents`、`sessions`、`models`、`selectedModelId` 等内存集合。

### 影响

用户切换到未安装或无会话的 Agent 时，看到的是上一个 Agent 的脏数据，造成严重的认知混淆。

### 修复

1. **删除 `filtered.isNotEmpty ? filtered : sessions` 错误回退**：`projectsForAgent(targetAgent)` 严格只返回 `s.agentId == targetAgent` 的会话；若为空则直接返回空列表 `[]`，抽屉展示 `空间 (0)` 与 `这台电脑尚未安装 Pi / OpenClaw`（并将「新建任务」按钮置灰禁用）。
2. **`selectAgent` 无条件重置关联状态**：切换 Agent 时直接执行 `activeSession = matching`（若无匹配则为 `null`），并立即清空 `models = const []` 与 `selectedModelId = null`。
3. **`loadModels` 校验模型归属**：若当前 `selectedModelId` 不在新加载的 `models` 列表中（或请求失败），立即重置为新列表默认模型或 `null`。
4. **`disconnect` 彻底清空状态树**：断开连接时一并清空 `agents`、`sessions`、`models`、`selectedModelId`、`activeSession` 与 `activeMachineId`。

### 预防措施

在编写任何按维度切换/筛选（如切换电脑、切换 Agent、切换项目、切换 Tab）的状态逻辑时：
1. **严禁写 `filtered.isNotEmpty ? filtered : allItems` 这类掩耳盗铃的回退**——选了什么维度就严格展示该维度的数据，没有数据就是空状态（Empty State）。
2. **严禁写 `if (next != null) current = next` 或 `selected ??= ...`**——切换父级上下文时必须无条件覆盖子级状态（包括将子级置为 `null` 或 `[]`），防止残留上一个上下文的幽灵数据。

## 2026-11-06 电脑端重启 `pnpm start` 或手机 App 重开时未自动调用 `deviceToken` 重连，且 `reconnectWithSavedCredential` 缺少 `127.0.0.1` 回退导致用户误以为需要重新扫码

### 问题

用户询问为什么每次电脑执行 `pnpm start` 重启后，手机端都要重新扫码，是不是没有保存身份凭证或凭证会变。

### 根因

电脑端 `.nienie/paired-devices.json` 和手机端 `FileCredentialStore` 实际上都已经持久化了 `deviceToken`，凭证并没有变；但手机端存在 3 个断线恢复缺口：
1. **启动未自动重连**：`loadSavedPreferences()` 只把 `savedMachines` 读进了列表，没有在 App 启动时自动调用 `reconnectWithSavedCredential()`。
2. **WebSocket `onDone` 未触发自动重连**：当电脑端 `Ctrl+C` 重启 `pnpm start` 时，旧 TCP 连接断开触发 `IoBridgeTransport.onDone`，但未通知 `MobileBridgeClient` 在后台自动凭 `deviceToken` 重新握手。
3. **`reconnectWithSavedCredential()` 缺少局域网 IP 变更回退**：当电脑从手机热点（`172.20.10.5`）切到路由器 Wi-Fi（`192.168.31.141`）时，保存的旧 IP 连不上，而 `reconnectWithSavedCredential` 未像 `pairAndConnect` 那样自动回退尝试 `ws://127.0.0.1:4100`（USB 通道）。

### 影响

每次重启 `pnpm start` 或切换网络后，手机端连接断开且不会自动重连，迫使用户手动重新扫码。

### 修复

1. **`loadSavedPreferences(autoReconnect: true)`**：手机 App 启动加载出已保存电脑后，自动静默调用 `reconnectWithSavedCredential()` 直接进入工作区。
2. **WebSocket 断开自动后台重连**：`IoBridgeTransport.onDone` 发出 `transport.disconnected` 事件，`MobileBridgeClient` 捕获后自动轮询 4 次（间隔 1.5s）调用 `reconnectWithSavedCredential()`，电脑重启 `pnpm start` 后手机端 1~2 秒内自动无感恢复连接。
3. **`reconnectWithSavedCredential` 补齐 `127.0.0.1` 自动回退**：当旧局域网 IP 不可达时自动回退至 `ws://127.0.0.1:4100` 并更新保存的地址。

### 预防措施

所有保存了长期 `deviceToken` 的客户端必须同时实现「冷启动自动免密重连」与「服务端重启（WebSocket `onDone`）指数/固定间隔自动重连」，严禁在已有有效凭据的情况下让连接静默死掉或要求用户重新扫码。

## 2026-11-06 错误地在主对话页面空白态渲染原本只属于左侧抽屉的项目文件夹与会话列表，破坏对话页纯净度

### 问题

用户指出扫码连接进入主页面后，在没有打开左侧边栏的情况下，主对话页面正中间竟然直接铺满了各种文件夹和历史对话列表（`gracious-neumann-8c7813`、`reverse_cracking` 等），而不是像 Kelivo 一样是一个干净纯粹的对话页面。

### 根因

1. 为了迁就早期 `mobile_app_test.dart` 中不打开抽屉就直接点击会话标题的断言，在 `_buildKelivoConnectedBody` 中写了 `hasMessages ? SessionTimelineList(...) : _buildEmptyWorkspaceTree(client)`，把原本只应该存在于左侧滑出抽屉（`KelivoWorkspaceDrawer`）的项目会话树塞进了主对话画布！
2. `ClaudeCodeAdapter` 扫描 `~/.claude/projects` 时未过滤已删除的 `.claude/worktrees/*` 临时目录。

### 影响

用户一进入对话主页，看到的不是干净的聊天窗口，而是满屏杂乱的文件夹列表，与 Kelivo 的极简对话页设计完全背道而驰。

### 修复

1. **彻底删除主页面中的 `_buildEmptyWorkspaceTree`**：主对话页面中央始终只渲染 `SessionTimelineList`（当新会话尚无消息时即保持 100% 纯净白色留白画布，与 Kelivo 1:1 一致）；项目文件夹与历史会话列表**只存在于左侧滑出抽屉（`KelivoWorkspaceDrawer`）**中。
2. **`ClaudeCodeAdapter` 过滤无效目录**：跳过包含 `/.claude/worktrees/` 或在磁盘上已不存在（`!existsSync(resolvedCwd)`）的临时工作树记录。

### 预防措施

严禁为了偷懒通过旧单元测试而将侧边栏/抽屉列表塞进主对话画布；主对话页面在空状态下必须保持 100% 纯净留白。

## 2026-11-08 官网 `[data-page="nienie"] a { color: inherit }` 选择器优先级高于 `.dl-btn`，导致深色下载按钮变成「黑底黑字」看不清文字，且 `<select>` 漏加下拉箭头与自定义焦点环

### 问题

1. 官网顶栏语言切换 `<select class="lang-select">` 设置了 `appearance: none` 后未添加右侧下拉箭头 SVG，也未设置 `outline: none`，导致既没有下拉指示箭头，点击后还出现粗糙的浏览器默认蓝色焦点框。
2. 官网下载卡片中的 `<a class="dl-btn">直接下载 APK</a>` 按钮呈现纯黑块，按钮上的文字变成黑色无法看清。

### 根因

1. 全局链接重置写了 `[data-page="nienie"] a { color: inherit; }`（CSS 优先级 `0, 1, 1`），而按钮样式写了 `.dl-btn { background: var(--page-ink); color: var(--page-bg); }`（CSS 优先级 `0, 1, 0`）。由于 `0, 1, 1 > 0, 1, 0`，`<a class="dl-btn">` 的文字颜色被强制覆盖成了父级深色 `--page-ink`（`#1f2521`），造成 `#1f2521` 背景上渲染 `#1f2521` 文字（黑底黑字）！
2. 对 `<select>` 使用 `appearance: none` 移除了系统原生箭头后，漏配了 `background-image` 下拉箭头 SVG 与 `outline: none`。

### 影响

官网核心下载按钮文字无法辨认，语言下拉框视觉残缺。

### 修复

1. 将 `.dl-btn`、`[data-slot="primary-button"]`、`[data-slot="cta-button"]` 选择器提升为 `[data-page="nienie"] a.dl-btn` 并显式声明 `background: #1f2521; color: #ffffff;`，彻底解决选择器优先级覆盖导致的黑底黑字问题。
2. 为 `[data-page="nienie"] .lang-select` 补齐内联 `chevron-down` SVG 背景图、右侧留白 `padding-right: 30px`、`outline: none` 以及翡翠绿 `:focus-visible` 焦点环。

### 预防措施

1. 当页面根节点使用属性选择器（如 `[data-page="..."] a { color: inherit }`）重置链接颜色时，所有充当按钮的 `<a>` 标签样式必须带上同级作用域前缀（如 `[data-page="..."] a.dl-btn`），并在上线前执行 `BUTTON CONTRAST CHECK` 检查按钮背景与文字对比度。
2. 凡是对 `<select>` 设置 `appearance: none`，必须同步成套配置自定义下拉箭头 SVG、`padding-right` 与 `outline: none`。

## 2026-11-08 将 CSS、JS、二维码、多语言字典全部硬塞进单个 `website/index.html` 导致文件膨胀至 1100+ 行，极难维护

### 问题

官网 `website/index.html` 把约 600 行 CSS、700 个 `<rect>` 二维码 SVG 格子、多语言字典 JS 与交互脚本全部内联硬编码，导致单文件超过 1100 行，改样式、改多语言文案或更新二维码都极难维护。误以为 Cloudflare Pages 只能托管单个 HTML 文件。

### 根因

1. 未拆分职责，把结构、样式、脚本、二进制资源（SVG）全部内联进 `index.html`。
2. 误解了 Cloudflare Pages 的能力——`wrangler pages deploy` 上传的是整个目录树（最多 2 万文件），并非只能放单个 HTML。

### 影响

单文件臃肿、样式与脚本混杂、二维码 SVG 数百行噪点混在 HTML 里，后续维护成本极高。

### 修复

按职责拆分为模块化多文件结构，并用 `wrangler pages deploy website` 整体发布：
* `index.html`（约 200 行纯净语义化 HTML，仅 `<link>` / `<script type="module">` 引用外部资源）
* `styles/tokens.css`（OpenCtrlC 暖色调色板、字体与深浅色变量）
* `styles/main.css`（布局与组件样式）
* `scripts/i18n.js`（中/英/日/韩四语字典与切换逻辑，ES Module 导出）
* `scripts/main.js`（命令复制按钮与语言切换初始化，`import { applyI18n }`）
* `assets/favicon.svg`（品牌图标）
* `assets/apk-qr.svg`（独立的 APK 下载二维码矢量图，从 HTML 中移出）
* `_headers`（Cloudflare Pages 安全响应头与静态资源缓存策略）

### 预防措施

1. **Cloudflare Pages 支持完整静态资源目录树**（HTML + CSS + JS + SVG/图片 + `_headers`/`_redirects`），严禁把 CSS/JS/资源内联进单个 HTML 文件，必须按 `styles/`、`scripts/`、`assets/` 职责拆分，并用原生 `<script type="module">` ESM 组织脚本。
2. 二维码、图标等矢量/二进制资源必须独立成 `assets/` 下的文件由 `<img>` 或 `<link rel="icon">` 引用，严禁把数百行 `<rect>` 格子直接内联在 HTML 标记里。

## 2026-11-08 `@matrixai/quic`（Cloudflare quiche）QUIC-over-hole-punched-UDP 握手永不收尾（经 ChatGPT 诊断）

### 问题

实现 RustDesk 式 Tier-2 P2P（UDP 打洞 + QUIC 隧道）时，PoC 里 UDP 打洞成功、`QUICClient` 发起握手（`Connect` → `Start QUICConnection`），但服务端始终不触发入站连接、客户端一直 pending。

### 根因（经 ChatGPT 按 `@matrixai/quic` 官方源码逐条诊断确认）

1. **`crypto.ops.sign()` 返回类型错（最关键）**：`sign()` 必须返回 **ArrayBuffer**，不能返回 `Buffer`/`Uint8Array`。`QUICConnectionId` 继承 `Uint8Array`，传 Buffer 会**复制整个 32 字节**而非截取前 20 字节（`quiche.MAX_CONN_ID_LEN`），导致 SCID 长度错误、TLS 握手永不收尾。`sign`/`verify` 同时用于 SCID 派生与 Stateless Retry Token，必须用同一 HMAC 密钥。
2. **入站连接事件名写错**：必须用 `events.EventQUICServerConnection.name`，不是字符串 `'connection'`。
3. **打洞必须用 `QUICSocket` 自身的 `socket.send()`**：与 QUIC 共享同一 NAT 映射；不能用独立 `dgram` socket（NAT 映射不共享）。`QUICSocket` 收到非 QUIC 的原始 UDP（如打洞包）会静默丢弃，这是正常的。
4. **`reuseAddr` 属于 `QUICSocket.start()`**（创建底层 dgram socket 时用），`QUICServer` 复用已有 socket 时不重新 bind、不涉及 `reuseAddr`。
5. **`client.randomBytes(data)`**：`data` 是 `ArrayBuffer`，用 `randomFillSync(new Uint8Array(data))` 原地填充。
6. **跨公网对端地址**必须用信令服务器观测到的公网 `IP:port`，不是 `socket.host/port`（那是本地 bind 地址）。

### 影响

QUIC 打洞 P2P 隧道无法建立，多级网络的 Tier-2 层不可用。

### 修复

1. `sign()` 返回 `toArrayBuffer(hmacDigest)`（`buf.buffer.slice(byteOffset, byteOffset+byteLength)`）。
2. 用 `events.EventQUICServerConnection.name` 监听入站连接。
3. 打洞改用 `socketA.send(Buffer, port, host)` / `socketB.send(...)`（QUICSocket 自身）。
4. Server/Client config 分离（客户端不持服务端私钥），加 `maxIdleTimeout` 避免无限 pending。
5. 修正后的 PoC 端到端跑通：**UDP 打洞 → 同 socket QUIC 隧道 → 双向消息收发**，并固化为防回归测试 `packages/bridge-core/tests/quic-p2p.test.ts`。

### 预防措施

1. 接入 `@matrixai/quic`（quiche 系）时：`crypto.ops.sign` 返回 **ArrayBuffer**、事件用 `events.*.name`、打洞用 `QUICSocket.send()`，三者缺一不可。
2. **P2P 打洞的 UDP 包必须与 QUIC 握手复用同一个 socket**，否则 NAT 映射互不相通。
3. 严禁把 RSA/ECDSA 签名（TLS 证书体系）与 HMAC（QUIC 连接 ID / Retry Token 派生）混为一谈排查 —— 它们是两套独立机制。

## 2026-11-08 esbuild 把 ESM-only + 原生 `.node` 模块打包进 CJS 导致 `pnpm start` 启动即崩

### 问题

`pnpm start` 启动 `electron-main.cjs` 时抛 `TypeError: The argument 'filename' must be ... Received undefined`（`Module.createRequire` 收到 `undefined`）。

### 根因

`@matrixai/quic` 是 **ESM-only**（`"type": "module"`，无 `require` 入口）且靠 `createRequire(import.meta.url)` 相对定位加载自身 `prebuild/*.node` 原生绑定。esbuild 把它**内联打包**进 CJS 的 `electron-main.cjs` 后，`import.meta.url` 被转成 `var import_meta = {}`，于是 `createRequire(import_meta.url)` → `createRequire(undefined)` → 启动即崩；且原生绑定的相对路径也会错乱。**原生 / ESM-only 模块本质不可被 bundle，必须 externalize + 运行时懒加载。**

### 修复

1. `packages/bridge-core/src/quic-p2p.ts`：`import type`（编译期擦除）+ 运行时 `await import('@matrixai/quic')` 懒加载（仅在真正使用 P2P 的 `bind/connect` 时加载）。
2. `scripts/start-mac.mjs`：对所有 Node 打包命令加 `--external:@matrixai/*`，不内联，运行时从 `node_modules` 动态加载。

### 防回归守卫（已固化为单元测试）

新增 **`packages/bridge-core/tests/bundle-externals.test.ts`**，从两个层面锁死约束：
1. **配置层**：断言 `scripts/start-mac.mjs` 含 `--external:@matrixai/*`（防止有人删掉 external 标记）。
2. **源码层**：断言 `quic-p2p.ts` 及 bridge-core 源码只用 `import type` + 动态 `import()` 引用 externalized 包，**严禁静态运行时 `import ... from`**（会被 esbuild 内联）。

已验证该测试能真正拦截回归：注入一个静态 `import { X } from '@matrixai/quic'` 后测试立即失败并提示「存在静态运行时导入，会被 esbuild 内联导致 CJS 崩溃」。

### 预防措施

1. **往 `bridge-core` / 桌面端打包链路添加原生（`.node`）或 ESM-only 依赖时，必须同时：**
   - 在 `scripts/start-mac.mjs` 的 esbuild 命令加 `--external:<pkg>`；
   - 在源码用 `import type` + 动态 `import()` 懒加载，严禁静态 `import ... from`。
2. **新增此类依赖时，记得在 `bundle-externals.test.ts` 的 `EXTERNALIZED_PACKAGES` 数组中登记包名前缀**，让守卫测试覆盖到。
3. 严禁把「运行时按 `import.meta.url`/`__dirname` 定位原生资源」的包内联进单文件 bundle（路径会错乱）。


















---

## OpenCode/MiMo 对带 `?directory=` 的会话不向全局 `/event` 推事件，导致手机发消息后收不到回复

### 现象

手机对项目会话（如「ideaboom 新任务」）发「你是什么模型」，OpenCode 后台正常生成了回复（DB `message` 表可见 `role:assistant` 完整文本），但**手机聊天界面只显示用户气泡，AI 回复一直不出现**。Bridge 日志里也看不到 `registry.onEvent` 的事件流水。

### 定位过程

1. 直接查 OpenCode DB：回复确实生成 → 说明 Prompt 链路正常，问题在**事件回流链路**。
2. 裸 fetch 订阅 `GET /event` 手动解析 SSE：能收到全部 25 个事件（`message.part.delta`/`session.idle` 等）→ OpenCode 事件流本身正常。
3. 用适配器 `connectEvents` + `normalize` 却只有 0~1 个事件 → 差异在会话的创建方式。
4. 对比实验（同一 prompt，不同建会话方式）：
   - 裸 `POST /session`（**不带** `?directory=`）→ 25 事件；
   - `POST /session?directory=<projectPath>`（**带** `?directory=`）→ **仅 1 个 `server.connected`，无任何会话/消息事件**。
5. 订阅 `GET /event?directory=<projectPath>` 再对带 `?directory=` 的会话发消息 → **25 事件恢复**。

### 根因

**OpenCode（及基于其 fork 的 MiMo）的事件总线按 directory 分片：**
- 会话用 `?directory=<projectPath>` 创建时，它的 `session/message` 事件**只推给** `GET /event?directory=<projectPath>` 这条 SSE，**不进**全局 `GET /event`。
- 适配器此前只连全局 `/event`，于是目录会话的所有事件被静默丢弃 —— 回复在 DB 里，但没人广播给手机。
- 而项目会话必须带 `?directory=` 创建，否则 OpenCode DB 的 `session.directory` 不会记录项目路径，手机端项目树会把会话归错项目。**这是「项目树正确」与「事件流正常」的两难，靠调用参数无法两全。**

### 修复

改为**按 directory 订阅 SSE**（`packages/agent-adapters/opencode/src/index.ts`）：

1. `connectEvents(directory?)`：由单一 `sseAbortController` 改为 `Map<dir, {controller, loop}>` 多连接，按会话 directory 订阅 `GET /event?directory=<dir>`（无 directory 时才订全局 `/event`）。
2. `createSession`：仍带 `?directory=<projectPath>` 创建（保证项目树正确），但**同时把 `projectPath` 记入 `sessionDirectories`**，供后续定位事件流。
3. `sendMessage` / `loadSession`：先 `connectEvents(sessionDirectories.get(sessionId))` 连上该目录的 SSE，再发 Prompt，确保该目录事件能回流。
4. `dispose` 中止并清理所有 per-directory 连接。

MiMo 适配器复用同一 `OpenCodeAdapter` 类，自动受益。

### 验证

`createSession({projectPath})` + `sendMessage` 现在稳定产出 `text_delta`（如 `text_delta:收到`）；项目树仍正确（OpenCode DB `session.directory` = projectPath）。全量 69 vitest + 10 flutter 测试通过。

### 预防措施

1. **凡对接 OpenCode 系（OpenCode/MiMo）事件流，必须按会话 directory 订阅 `GET /event?directory=<dir>`，不能只连全局 `/event`**，否则目录会话事件静默丢失。
2. 新增 Agent 适配器时，务必验证「带项目上下文建会话 → 发消息 → 事件能否回流」这条链路，而非只测无目录的裸会话。
3. 排查「回复生成了但不显示」类问题，优先核对**事件回流链路**（适配器 SSE 订阅 → normalize → Bridge 广播 → 手机渲染），而非 Prompt 生成链路。

---

## SSE 事件回流修复的五个隐性缺陷（ChatGPT 复盘）

在完成 directory 级 SSE 订阅修复后，请 ChatGPT 做 code review，它指出了五个「测试能过但生产有隐患」的隐性缺陷，已逐一修复。这些是长期工程经验。

### 1. `buildHeaders` 默认目录覆盖显式目录（隐蔽 bug）

`buildHeaders` 无条件用 `this.directory`（适配器默认目录）覆盖 `x-opencode-directory`，导致 `connectEvents(dir)` 传入的**会话级目录**被适配器默认目录盖掉，HTTP Header 与 URL 的 `directory` 不一致，行为依赖 OpenCode 对两参数的优先级。修复：仅当未显式传入时才填默认目录（`if (this.directory && !headers['x-opencode-directory'])`）。**通用教训：默认值填充必须让位于显式传参，不能覆盖。**

### 2. `mapSession` 不缓存 directory → 旧会话恢复回退到全局流

`mapSession` 计算了 `raw.directory ?? fallbackDirectory ?? this.directory` 却没写入 `sessionDirectories`，导致重启后打开旧项目会话时 `sendMessage` 取不到目录，回退连全局 `/event`，把最初的 bug 又带回来。修复：`mapSession` 统一缓存 `sessionId → directory`。**通用教训：任何把「会话↔目录」映射用于路由的地方，都必须保证映射被完整填充（含 mapSession / loadSession / listSessions 所有入口）。**

### 3. `connectEvents` 并发重复建连接竞态

`Map.set` 在 `await fetch` 之后。同一目录两个并发调用都发现 map 无此 key，各自建连，第二条覆盖 map，第一条成野连接（且两条都 emit → 手机重复显示回复）。修复：先把 entry（含 controller）登记进 map，再建连；并发调用复用同一 `ready` Promise。

### 4. `dispose` 与建连过程的生命周期竞态

`dispose` 看到的 map 为空（连接还在 fetch 中），无法中止未登记的 controller；fetch 返回后连接仍会建立（已 dispose 的 adapter 又连上 SSE）。修复：加 `disposed` 标志 + 建连前/fetch 返回后都检查 + 先登记 entry 使 dispose 能中止建立中的连接。

### 5. 吞掉 SSE 建立失败仍发 Prompt → 重现「生成了但没回复」

`connectEvents(knownDir).catch(() => undefined)` 吞掉错误后仍发 Prompt，Agent 生成成功但无事件订阅者，手机 Thinking 45 秒后超时——正是最初 bug 的症状。修复：`sendMessage` 强一致——SSE 建立失败就不发 Prompt、直接抛错（手机显示错误可重试）；`loadSession` 保持宽松（历史回放仍可用）。**通用教训：远程控制链路里「发送成功 / Agent 执行 / 事件传输 / 手机展示」是四件事，不能用一个 sendMessage 成败笼统代表。**

### 6. 手机端 Retry 可能重复执行危险任务

`retryPrompt` 无条件重发 prompt。若 Agent 正在执行「删除所有未使用文件」这类操作，超时后点 Retry 会二次执行。修复：超时 watchdog 先查会话状态，`running`（Agent 工作中）不算超时、继续等待；仅当非 running 且无回复才判定超时（此时 Retry 才安全）。同时 error / permission waiting / idle 都会收起「等待中」占位。**通用教训：面向 Agent 的重试必须区分「执行中」和「已失败」，绝不能盲目重发。**

### 测试策略补充

- mock 应复刻真实事件投递语义（OpenCode 的 directory 隔离），否则测试双连接会重复计数、掩盖真实行为。
- 守卫测试应断言「必须存在目录级订阅」（正向），而非「不能有全局订阅」（过度约束，正确实现可能两者都有）。
- 多会话测试要断言 sessionId 归属，防止跨会话串扰。
- 诊断工具应按 sessionId 过滤，排除同目录其他会话事件干扰。

### 后续建议（ChatGPT，待做）

P2：SSE 自动重连 + 指数退避、目录连接引用计数/闲置回收、事件历史恢复、`AgentEventConnectionManager` 统一管理 SSE 生命周期（供各适配器复用）。

---

## SSE 事件流管理器的五个 P0/P1 语义缺陷（ChatGPT 第二轮复盘）

在抽象出 AgentEventConnectionManager 后再请 ChatGPT review，它指出了几个「测试能过、生产有隐患」的 API 语义缺陷。核心教训：**「首次连接成功」不等于「当前连接可用」**。

### 1. ensure() 复用首次连接的旧 Promise（会让原 bug 复现）
`entry.ready` 只在首次连接 resolve，之后即使断线重连中，`ensure` 也返回旧的已 resolve Promise，`sendMessage` 于是误以为 SSE 就绪、继续发 Prompt → 「生成了但手机收不到回复」重现。修复：拆出 `waitUntilConnected(key)`，用**每次连接独立的 Deferred**（断线即换新），`connectEvents` 改为 `ensure` + `waitUntilConnected` 强一致。**教训：连接就绪判定必须反映「当前」状态，不能复用历史 Promise。**

### 2. dispose()/close() 没等后台 supervisor 真正退出
`setTimeout(0)` 只让出一次事件循环，不等于后台任务结束。修复：`entry.supervisor` 保存后台任务，`dispose`/`close` 用 `await Promise.all(supervisor)` 真正等待退出。

### 3. mock 流不遵守 AbortSignal → dispose 卡死
管理器依赖 `for await` 在 abort 时退出。若底层 AsyncIterable 不响应 AbortSignal（测试 mock 就是），`for await` 永久阻塞，`dispose` await supervisor 卡死。修复：mock 流的 `next()` 需 `signal.addEventListener('abort', ...)` 唤醒；真实适配器靠 fetch signal 天然遵守。**教训：连接管理器的取消语义依赖传输层遵守 AbortSignal 约定，测试必须模拟这一点。**

### 4. 建连期间被 close/dispose 后仍会置为 connected
`await connect()` 返回后未复查 `disposed/closed/aborted`，已关闭的连接可能「复活」为 connected。修复：`await connect()` 后立即复查三者。另 `ensure()` 在已 dispose 时应抛 DisposedError 而非静默成功。

### 5. /diagnostics 无鉴权泄露本机环境信息
HTTP 直出项目路径/Session ID/machineId。修复：仅允许 localhost 访问 + `Cache-Control: no-store` + 目录 key 折叠为 basename 脱敏。

### 未做（ChatGPT 建议的 P0，留待后续）
SQLite rowid 水位无法发现已有 part 的 UPDATE（需 partId+revision 复合水位）；事件协议缺 streamEpoch（Bridge/重启后 sequence 重置会让手机误丢事件）；手机 Retry 需查电脑端实时状态而非本地缓存。这三个是「事件可靠性协议」级改造，ChatGPT 建议作为下一个独立提交重点做。

---

## 事件可靠性协议的三个本质问题（ChatGPT 第三轮定调）

ChatGPT 明确：远程 Agent 控制应追求 **At-least-once delivery + Idempotent processing**（不追求不现实的 exactly-once 网络传输）。据此修复三个本质问题：

1. **sequence 是进程内计数器**：Bridge/Adapter 重启后 normalizer 重建、sequence 归 1，手机端 `sequence <= lastSeq` 会把新事件全当旧事件丢弃，直到 sequence 超过重启前的值。修复：协议加 `streamEpoch`，客户端按 `(sessionId, streamEpoch, sequence)` 判重，epoch 变即重置。

2. **rowid 水位无法发现已有 part 的 UPDATE**：OpenCode 会 UPDATE 已存在的 part 记录（流式文本增长就是同一条 part 反复 UPDATE），`WHERE rowid > 水位` 永远看不到更新。修复：改 partId + emittedLength 复合水位，只补发 `content[已回放长度:]` 缺失后缀，幂等且捕获增长。

3. **randomUUID 历史事件 ID 不幂等**：每次回放生成新 `hist_xxx`，客户端无法识别重复。修复：稳定 eventId `history:{sessionId}:{partId}:{revision}` + 客户端 `eventId` 去重。

### 已知边界（后续用 part-snapshot 协议彻底解决）
若 Bridge 在 part 更新中途重启，adapter emittedLength 归零会全量重发，而客户端只有部分前缀，理论上可能重复前缀。彻底解法是 ChatGPT 建议的 part snapshot/update 事件（partId+revision+完整内容，客户端按 partId 覆盖而非追加），本版已为每条历史事件带上 partId/partRevision 铺垫。

---

## 真机 ADB 端到端验证：手机收不到回复的根因是「运行中的 Bridge 是旧代码」

用户反馈手机发消息依然没回复。用 ADB 真机（OnePlus PLF110）端到端排查，根因不是逻辑 bug，而是**运行中的 Bridge 跑的是旧 bundle**：
- `curl :4100/diagnostics` 返回 404 → 说明 Bridge 没加载我后加的诊断/重连/SSE 修复（dist 是旧时间点构建的）。
- 重建桌面 bundle（`pnpm start`）+ 重启 Bridge 后，`/diagnostics` 正常、`adapters.opencode[0].state=connected receivedEvents=85`，手机端到端「hello → 你好，Hello！…」回复立刻正常。

**通用教训：改了 Bridge/适配器代码后，必须重建桌面 bundle 并重启 Bridge 才会生效**；`/diagnostics` 可作为「Bridge 是否在跑新代码」的快速探针。排查「手机没回复」先确认 Bridge 是不是旧的，再查逻辑。

### 设备命名千篇一律
手机端硬编码 `deviceName='Nienie Flutter Mobile'` + `platform='ios'`（连 Android 都写死 iOS），导致桌面「已连接设备」全一样无区分度。改用 `device_info_plus` 取手机型号（Android: brand+model，iOS: 用户设备名）+ 按实际 `Platform.operatingSystem` 上报。真机验证新配对设备名 = `OnePlus PLF110 | android`。注意设备名在配对时一次性写入，改完需重新配对才生效。

### 附带构建 bug
Android 资源名 `niebie-launch-image.png` 含 `-` 不合法（Android 资源只允许 a-z0-9_），导致 `flutter build` 失败；XML 引用的是 `niebie_launch_image`（下划线）。重命名文件对齐即可。

---

## 2026-11-10 官网静态页与桌面端各自维护图标，占位圆点直接上线

- 现象：用户手机浏览器打开官网，「支持的 Agent」区 OpenAI Codex / Xiaomi MiMo Code / DeepSeek Harness 三张卡片只显示蓝/橙/蓝纯色圆点，而桌面客户端同款 Agent 已能正确显示官方品牌图标；用户以为是「图标加载失败」。
- 原因：官网 `website/index.html` 是独立静态页，这三张卡片当初手写的是占位 `<svg><circle r="9"/></svg>`；桌面端后来在 `apps/desktop/src/ui/AgentBrandIcons.tsx` 补齐了 5 个官方 SVG，但没有回流到官网。不是资源 404、不是 CSP、也不是缓存——两份代码各自维护，压根没同步过。
- 经验：**同一套品牌资产在多端出现时，必须明确单一来源**；桌面端补齐图标后要回头检查官网、README、文档等其它展示面。静态官网优先内联 SVG（不依赖外部资源），并做一次无头浏览器渲染验证，不能只看 HTML 文本对不对。
- 处理：脚本从桌面端组件提取 5 段官方 SVG，把 JSX 属性（`fillRule` / `stopColor` 等）转成 HTML 属性后内联进官网卡片；本地与线上截图 MD5 完全一致，重新部署 Cloudflare Pages 生产环境。
- 关联：同轮发现 `FEATURE.md` 把官网地址写成 `https://nienie.quniv.cn`（该域名从未配 DNS），被 boss_host 项目卡片照抄成死链。文档里的「规划 URL」要标注状态，或直接写当前真实可访问地址；外链发布前必须实际访问验证。

---

## 2026-11-10 换 logo 后浏览器标签页仍是旧图标：favicon 缓存与 _headers 规则重叠

- 现象：官网 Agent 图标修好、P6 小猫 favicon 文件也已在仓库里，用户手机浏览器 tab 仍显示旧的绿色 N 字标。
- 原因排查：先从 `favicon.ico` 二进制里拆出 32px 帧确认图案已是小猫、线上所有图标 md5 与本地一致 → 文件没问题；再看缓存头，图标走 `/assets/*` 的 `max-age=86400, stale-while-revalidate=604800`，加上 Chrome 对 favicon 有独立顽固缓存，旧图标被长期留住。且新图标文件生成后并未立刻部署到 Pages（官网上一次部署仍是旧 N）。
- 经验一：**换 logo 要同步部署所有展示面**（桌面 / 移动 / 官网 / 项目卡片），本地文件更新不等于线上已更新；验证要查线上资源哈希，不能只看仓库文件。
- 经验二：**favicon 必须靠 URL 版本号破缓存**（`favicon.ico?v=2` 等），仅靠服务器 Cache-Control 对 Chrome 的 favicon 缓存通常无效；以后每次换图标递增 `?v`。
- 经验三：**Cloudflare Pages 的 `_headers` 多条规则匹配时，同名 header 会被逗号合并而不是覆盖**——曾写出 `max-age=86400, ..., max-age=0` 这种自相矛盾的响应头，浏览器取前面的长缓存，规则形同虚设。设计缓存规则时必须避免路径重叠，部署后用 `curl -I` 逐条确认只返回一条 Cache-Control。
- 处理：5 个图标引用加 `?v=2`；`/assets/*` 统一缩短为 1 小时，`favicon.ico` / `site.webmanifest` 单独 no-cache；重新部署并逐项验证。

---

## 2026-11-10 手机会话桌面版看不到：OpenCode v1/v2 共用同一个 opencode.db 但不同表，迁移是一次性的

- 现象：用户在 Nienie 手机端建的会话（ideaboom 新任务等）在桌面 OpenCode.app 里完全看不到；但 v1 时代建的旧会话（crawler_console 等）桌面又能看到，误以为 v2 向下兼容。
- 根因（探索 OpenCode v2.2.5 源码 + sqlite 实测）：v1（`~/.bun/bin/opencode` 1.19.5）和 v2（桌面 OpenCode.app 2.2.5）**共用同一个 `~/.local/share/opencode/opencode.db` 文件，但读写不同的表**——v1 写 `session/message/part`，v2 写 `session_v2/session_message/session_part`。v2 启动时跑一次 `v1-migration.bun.ts` 把 v1 行拷进新表，状态标记 `kv.migration.v1-v2={"phase":"completed"}` 后**永不重扫**。所以迁移完成之后 v1 新建的会话（手机建的全部）v2 永远看不到。实测：v1-only 91 条（按 id anti-join）+ v2-only 3 条，净差 88 = 584-496。数量差要按 session id 做 anti-join 核对，别只比较 COUNT。
- 致命陷阱：**不能删 kv 的 `migration.v1-v2` 标记重跑迁移来"补迁"**——迁移循环会 `DELETE FROM session_message` 后按 v1 源重建，会把已导入会话在 v2 时代的新消息覆盖掉（数据损坏）。官方补迁正道是 `POST /api/experimental/session/import`。
- 另一个易错点：桌面 spawn 的 `opencode-cli serve --service` 监听 `127.0.0.1:49374`，**不是随机端口而是 `0xC0DE=49374` 固定服务端口**（官方故意固定，让第二个竞争者绑定失败退避，防双 Server 写同一库）。v2 HTTP API 在 `/api/` 前缀下（`GET /api/session`），直接 curl `/session` 会返回 web UI HTML——别据此误判"服务不可用"。
- 经验一：**"桌面能显示旧数据"≠"产品向下兼容"**，要分清一次性迁移导入和持续兼容两种机制；排查"数据 A 在客户端 X 看不到"先查两边各写哪个库/哪张表，再查有没有迁移标记（kv/state 表）短路逻辑。
- 经验二：**两个进程共用一个 sqlite 文件 ≠ 可以双写**——WAL 只保证并发读和写串行化，不保证两个 Server 进程各自的 Event Bus/会话执行状态一致。官方自己就用固定端口防双服务。要共享会话必须共享同一个 Server 进程（attach 官方 service），而不是共享数据库文件。
- 经验三：直接读 Agent 内部 sqlite 表的实现（Nienie v1 适配器的 readLocalSqliteSessions/emitSqliteSessionHistory）天生脆弱，上游一改 schema 就断；长期应走 HTTP API + 官方事件/日志接口（v2 的 `/api/session/:id/message` + `/api/experimental/session/:id/log` Durable Event Log），把 schema 变化挡在 API 层。

### 2026-11-10 Flutter 工具静默卡死：残留 lockfile + quarantine

- 现象：`flutter test` 超时零输出，随后 `flutter --version`、`dart --version` 全部无输出挂死；无 dart/僵死进程。
- 根因：两个叠加——a) 上一轮测试被超时杀死后 `bin/cache/lockfile` 残留（flutter 工具会等锁）；b) dart 二进制带 `com.apple.quarantine` 属性，`sample` 显示卡在 `_dyld_start`（Gatekeeper 首次校验弹窗/等待）。删除 lockfile 后校验放行即恢复。
- 经验：进程"静默零输出挂死"先 `ps -o stat` + `sample <pid>` 看卡点（quarantine 卡 dyld 会显示 `_dyld_start`），再查 `xattr <bin>` 是否有 `com.apple.quarantine`；flutter 相关挂死优先清 `bin/cache/lockfile`。注意 macOS 自带 xattr 不支持 `-r`，批量清除要用 `find ... -exec xattr -d com.apple.quarantine {} +` 或 `xattr -c`。

### 2026-11-10 v2 Diff API 对老迁移会话 500：assistant.snapshot 引用悬空

- 现象：`GET /api/session/:id/diff` 对部分会话返回 500「Unexpected server error」，但参数解析正常（错误 from 能正确 404「Message not found」）；新建 v2 会话 diff 正常。
- 排查：对比两组会话——diff 失败的 `ses_fe7779740ffe...` 有 72/73 条 assistant 消息带 `snapshot:{start,end}` 引用；diff 成功（0 文件）的 `ses_e6908e193ffe...` 0 条引用。指向服务端按 snapshot 引用算 diff 时快照存储内容缺失（v1→v2 迁移年代的数据）→ 计算崩溃。
- 结论：这是 OpenCode 服务端对悬空快照引用的容错缺失，非 Nienie 客户端问题。影响面：老会话（迁移批次）查看文件差异会失败；新建 v2 会话无此问题。手机端 Diff 卡片对该错误应展示空态而非崩溃。
- 经验：对照/集成测试遇到 500 先做「参数正确性对照」（错误参数应 404/400）排除自身请求问题，再对比新旧数据找差异字段（本例 snapshot ref 有无）定位数据年代限制。

### 2026-11-11 通知系统首轮 NOT ACCEPTED：mock 测试绿 ≠ 端到端成立（路线图#1 终审教训）

- 真机 HTTP 冒烟抓到 mock 测不出的 bug：`fetch` 拒绝非 latin1 header 值（中文标题直接抛错）；且 **Bun 与 Node/undici 对 header 字符串编码行为不同**（Bun 会二次 UTF-8 编码），验证必须在生产运行时（Node/Electron）做。教训：涉编码/网络语义的验证必须真实传输层，mock 只能验证调用形状。
- ChatGPT 终审抓出 4 个 P0 功能阻塞，全部源于「组件各自正确但链路没打通」：a) preload API 加了但 preview-server 的 IPC 映射表没加（真实 Electron 窗口调不通）；b) sender 在 startBridge 时定死，改配置不生效（测试按钮自建 sender 反而掩盖）；c) 手机端 registerPushToken 从未被调用，registrations 空导致通知全被静默吞掉；d) 通知异常无 .catch 可能崩主进程。教训：**每加一条配置链路要验证「UI→IPC→运行时对象」全路径生效**；通知这类旁路系统的失败必须隔离在主链路之外。
- 产品判断教训：路线图 [x] 不能只凭「代码写了+单测绿」就打勾——ChatGPT 以「桌面配置→发送→手机收到→点击进会话→完成审批」的用户闭环为验收标准，点击跳转/审批入口缺失就不算完成。打勾标准=用户闭环，不是代码完成度。

---

## 2026-11-12 方案讨论把「自用」和「公开发布」混为一谈：APNs 私钥绝不能落到用户设备

- 现象：讨论通知实现时，给出「桌面 Bridge 可以直接 POST APNs，只要电脑上有 .p8 私钥」和「用 Bark/ntfy 就不用专门服务器」两条建议。用户指出产品是面向所有人的，私钥不可能分享出去。
- 根因：**默认把部署模型当成了单机自用**，没有先确认「谁持有信任根、软件发给谁」。混淆了两种完全不同的场景：自用/极客自带通道 vs 公开发行的多用户产品。
- 结论（公开产品唯一正确形态）：
  - APNs `.p8` 私钥是 **Apple Developer Team 级别、一个 App 全体用户共用一份**，只存于开发者自己控制的常在线服务端；用户电脑、手机、App 包、git 仓库里都不允许出现。
  - 用户电脑 Bridge 只持配对身份（`deviceToken`），只上报「某会话 waiting/idle/error」这类脱敏事件；用户手机只持自己的 `device token`。
  - 服务端负责 `deviceId → device token` 映射、验 Bridge 身份、限流、用私钥签名发 APNs/FCM。
  - 因此常在线的推送网关是**安全边界上的必需件**，不是可选的性能优化；Bridge 直连 APNs 等于把全 App 群发能力下发到每台用户电脑，属严重安全事故。
  - Bark/ntfy 属于「用户自带通道」：通知弹在第三方 App 里、点击打不开本 App，只适合自用/调试，不能作为公开发行产品的推送方案。
  - 国内 Android FCM 不可用，需厂商通道；凭据归属规则相同（服务端唯一一份）。
- 经验一：**讨论架构前先锁定部署模型**（自用 / 团队 / 公开发行），涉及密钥、账号、证书、配额的结论在这三种模型下往往相反。给方案时先问「这东西最后发给谁用」，不要默默按最省事的单机场景推演。
- 经验二：任何「把开发者账号级凭据放进客户端」的方案一律直接否决，不需要权衡。客户端只能持有**单设备、可撤销**的凭据（如配对 deviceToken、device token），不能持有全局信任根。
- 经验三：现有 `WebhookPushSender` 定位应写明为「自用/自带通道」，产品化要新增服务端 `ApnsPushSender`/`FcmPushSender`；`PushProvider` 已预留 `'apns'|'fcm'|'webhook'` 无需改协议。若由 Relay 承载网关，须遵守 `docs/architecture/relay.md`：只传脱敏摘要，不传 Prompt/工具输出/Diff。

### 2026-11-12 Python `str.replace` 静默未命中导致「修了但没修上」

- **事故**：F1 草稿保护用 `python3` 批量 `str.replace` 打补丁，脚本无条件打印 'ok'——按钮分支的替换因缩进/内容不匹配**静默失败**，实际提交的还是旧的无保护 `clear()`；debug 打印替换同样静默失败导致排查方向被带偏（以为 handler 没执行）。
- **教训**：批量 `str.replace` 必须断言命中（`assert old in s` 或替换后 `grep` 验证目标行存在）；否则用 edit 工具（未命中会报错）。「脚本跑完打印 ok」≠「补丁生效」。
- **预防**：批量补丁后统一 `grep -c` 校验关键新代码行数；测试红了先怀疑补丁未命中，再怀疑逻辑。

### 2026-11-12 移动端事件序号缺口缓冲会「暂存永不应用」跳号事件

- **事故**：F1 测试发 `sequence: 100` 的 idle 事件（跳号 1..99），客户端缺口缓冲把它暂存并触发 replay（fake 无回放内容）→ 事件永不应用 → pending 不消、`_isGenerating` 卡真，测试行为诡异。
- **教训**：J0 事件流是严格连续序号（`seq <= lastApplied` 丢重复、`> lastApplied+1` 暂存+回放）；**测试构造事件必须用连续序号**（从 1 起递增），跳号事件不是「丢弃」而是「等回放补齐」，没有回放源时等于永久滞留。
- **预防**：测试 emit 辅助函数统一维护 per-session 自增 sequence；排查「事件没生效」先查是否被缺口缓冲暂存。

### 2026-11-12 flutter_markdown 自定义 pre builder 会触发 `_inlines.isEmpty` 断言

- **事故**：MarkdownMessage 用 `builders: {'pre': 自定义 builder}` 整体接管围栏代码块渲染，builder.dart 运行时断言 `assert(_inlines.isEmpty)` 崩溃。
- **根因**：visitText 优先命中 `builders[_blocks.last.tag]`（即我们的 pre builder），返回 null → inline 缓冲的 `_InlineElement` 没有任何 child；`_addAnonymousBlockIfNeeded` 只在 `inline.children.isNotEmpty` 时才 `_inlines.clear()` → 缓冲泄漏 → 尾部断言失败。
- **修复**：自定义 block builder 必须同时实现 `visitText` 返回占位 widget（`SizedBox.shrink()`），保证 inline 缓冲可被清空；同时把 `codeblockDecoration` 置空避免默认 pre 底色包裹自定义块。
- **预防**：接管 flutter_markdown 的 block 级 tag（pre/table 等）时，先读 builder.dart 的 `_addAnonymousBlockIfNeeded`/`visitText` 分支契约，别假设「children 就不会被访问」。

### 2026-11-12 简版 `str.replace` 全局误替换 + git stash 二分后文件残缺

- **事故一**：脚本里偷懒用只含 `assert old in s` 的简版 rep（无 count==1 断言），`s.replace` 全局替换把 5 处快照 map 的 `'totalParts': 1,` 一并删除 → 4 个无关快照测试静默变红，排查方向被带偏。
- **事故二**：用 `git stash` + `git checkout stash@{0} -- <file>` 二分定位回归后忘记恢复其余文件，stash drop 前工作区只剩部分改动（message-restore/state-store/protocol/测试回到 HEAD），测试计数异常才发现。
- **教训/预防**：①批量替换一律用带 `count==1` 断言的 rep 或 edit 工具；②git stash 二分流程固定为「checkout 参与文件→跑测→立即 checkout 全部改动文件回来→验证 diff 文件数→再 drop stash」，drop 前先 `git diff HEAD --stat` 核对文件清单；③测试计数（125→124）这类「数不对」的异常就是文件残缺的信号。

### 2026-11-12 testWidgets 假时钟区内 await 真实文件 I/O 死锁

- **事故**：testWidgets 用例直接 `await FileCredentialStore(...).saveQuickCommands(...)`（真实磁盘 I/O）→ 10 分钟 TimeoutException 死锁；`tester.runAsync` 包住「假时钟区已启动的文件 Future」同样死锁。
- **根因**：AutomatedTestWidgetsFlutterBinding 的 FakeAsync 控制微任务/定时器——假时钟区内启动的真实文件 I/O，其续体挂在假区域微任务队列上无法推进；runAsync 等待该 Future 时假区域被冻结 → 互锁。
- **修复**：真实 I/O **全部**在 `tester.runAsync(() async {...})` 回调内发起并 await（回调整体运行在真实事件循环），再 pumpWidget；预加载优于 pumpAndSettle 后补加载（后者同样等不到任意 Future）。
- **预防**：testWidgets 内磁盘/网络测试一律 runAsync 包裹 I/O；纯数据链路测试优先用 `test()`（真实区域）而非 testWidgets。
