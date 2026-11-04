# 手机与 Bridge 协议

## 传输

MVP 使用 WebSocket 双向通信：

```text
Flutter Mobile App <-- WebSocket --> Electron Main Process Bridge
```

## 客户端命令

```text
hello
ping
pair.confirm
push.register
machine.get
agents.list
models.list
sessions.list
session.create
session.load
session.state
session.diff
session.send
session.cancel
permission.reply
events.replay
screen.capture
```

### 请求与响应信封

客户端发送带 `requestId` 的命令：

```json
{
  "type": "session.send",
  "requestId": "req_123",
  "sessionId": "ses_alpha",
  "message": "运行测试"
}
```

Bridge 返回对应的 `response` 或异步推送 `session.event`：

```json
{
  "type": "response",
  "requestId": "req_123",
  "ok": true,
  "data": {
    "accepted": true,
    "sessionId": "ses_alpha"
  }
}
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

### 二维码配对载荷 (`nienie://pair?data=<base64url>`)

```json
{
  "version": 1,
  "machineId": "machine_local",
  "wsUrl": "ws://192.168.1.10:4100",
  "relayUrl": "wss://nienie-replay.quniv.cn",
  "pairingCode": "849201",
  "expiresAt": "2026-11-04T12:05:00.000Z"
}
```

### `pair.confirm` 请求与响应

```json
{
  "type": "pair.confirm",
  "requestId": "req_pair_1",
  "pairingCode": "849201",
  "deviceName": "iPhone 17 Pro",
  "platform": "ios"
}
```

```json
{
  "type": "response",
  "requestId": "req_pair_1",
  "ok": true,
  "data": {
    "deviceId": "dev_123",
    "deviceToken": "ntk_...",
    "machineId": "machine_local",
    "pairedAt": "2026-11-04T12:00:10.000Z"
  }
}
```

## 重连要求

- 每个事件包含递增 `sequence`。
- 手机记录每个会话最后确认的序号。
- 重连后先请求缺失事件，再恢复实时订阅。
- Bridge 重启后必须明确返回会话是否仍然存在，不能伪造运行状态。
