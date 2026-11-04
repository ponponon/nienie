# 手机与 Bridge 协议

## 传输

MVP 使用 WebSocket 双向通信：

```text
Flutter Mobile App <-- WebSocket --> Electron Main Process Bridge
```

## 客户端命令

```text
pair.confirm
machine.get
agents.list
sessions.list
session.create
session.load
session.send
session.cancel
events.replay
```

## 服务端事件

```text
pair.result
machine.snapshot
agents.snapshot
sessions.snapshot
session.event
session.state
error
```

## 配对要求

- 配对码必须一次性使用并设置过期时间。
- 手机获得的设备凭据必须可单独撤销。
- Bridge 不接受未认证设备的 Agent 操作。
- 生产环境不能把长期密钥放进二维码明文。
- MVP 可以先使用本地网络配对，后续再加入 Tailscale、Relay 或其他远程网络方案。

## 重连要求

- 每个事件包含递增 `sequence`。
- 手机记录每个会话最后确认的序号。
- 重连后先请求缺失事件，再恢复实时订阅。
- Bridge 重启后必须明确返回会话是否仍然存在，不能伪造运行状态。
