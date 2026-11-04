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
