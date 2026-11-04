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
