# 公网 Relay

## 目标

局域网直连适合开发，但正式使用需要一个公网 Relay，让手机和电脑都通过出站连接建立通信，不要求用户开放电脑入站端口。

```text
Flutter Mobile
      | WSS
      v
Public Relay
      ^
      | WSS
Electron Bridge
      |
      +-- OpenCode
      +-- Codex
```

## 默认地址

Nienie 提供一个可替换的默认 Relay 地址：

```text
wss://nienie-replay.quniv.cn
```

这个地址只作为默认配置和测试入口，不代表用户必须信任或使用该 Relay。正式客户端必须提供自定义 Relay 配置入口。

## 用户自定义 Relay

用户可以在桌面端或手机端设置自己的 Relay 地址：

```text
wss://relay.example.com
```

配置优先级：

```text
用户自定义 Relay
    > 默认 Relay
```

自定义 Relay 至少需要兼容 Nienie 的 WebSocket Relay 协议版本，并提供 TLS/WSS。

## Relay 的职责

- Bridge 和手机的在线连接管理
- 配对请求转发
- 设备路由
- 加密消息转发
- 短暂的断线缓存
- 连接心跳和清理

## Relay 不应承担的职责

- 不启动或执行 Agent
- 不读取电脑文件
- 不保存 Agent API Key 或 CLI 登录凭据
- 不解析用户 Prompt、工具输出、Diff 或代码内容
- 不把用户会话当作产品数据库长期保存

## 隐私模型

Relay 应尽量采用端到端加密消息转发：

```text
手机加密消息
    ↓
Relay 只看路由元数据和密文
    ↓
Bridge 解密并执行
```

Nienie 使用 `AES-256-GCM` 对 `relay.forward` 的 `encrypted` 载荷进行端到端加密，并保留自定义 Relay 的协议边界，不把默认 Relay 设计成不可替换的中心服务。

## 仓库隐私边界

仓库只记录公开的默认域名和 Relay 协议，不记录任何个人服务器、云厂商、SSH 信息、账号、密码、部署命令或个人基础设施细节。
