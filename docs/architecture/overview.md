# 架构总览

## 目标

Nienie 由手机端、桌面端和本地 Agent Bridge 组成。Agent 继续运行在用户电脑上，手机只负责展示和控制，桌面端负责把手机请求连接到本机 Agent。

## MVP 架构

```text
Flutter Mobile App
        |
        | WebSocket
        v
Electron Main Process
Node.js + TypeScript Bridge
        |
        +-- OpenCode Adapter
        +-- Codex Adapter
        +-- Session Manager
        +-- Event Normalizer
        +-- Pairing Manager
        +-- Permission Router
        |
        +-- OpenCode HTTP/SSE or SDK
        +-- Codex structured runtime
```

## 组件职责

### Flutter Mobile App

- 展示机器、Agent 和会话
- 展示统一 Agent 事件
- 发送 Prompt
- 展示权限请求
- 执行断线重连
- 保存手机侧设备凭据

### Electron Desktop

- 提供桌面配置界面
- 展示配对二维码
- 管理 Bridge 生命周期
- 展示本地 Agent 发现结果
- 展示日志和诊断信息

### Node.js Bridge

- 管理手机 WebSocket 连接
- 管理设备认证
- 发现和连接 OpenCode/Codex
- 管理会话生命周期
- 把 Agent 原始事件转换为统一事件
- 广播事件和处理手机命令

## 生命周期

```text
启动 Electron
    ↓
启动 Bridge
    ↓
发现 OpenCode / Codex
    ↓
生成一次性配对码
    ↓
手机扫码
    ↓
建立设备凭据
    ↓
手机获取机器和 Agent 列表
    ↓
创建或恢复会话
    ↓
发送 Prompt / 接收事件
```

## 未来拆分

MVP 阶段 Bridge 嵌入 Electron 主进程。后续如果需要后台常驻、Linux 无 GUI 运行或更强的系统服务能力，再拆成独立的 Node.js Daemon。手机协议不能依赖 Electron UI 生命周期。
