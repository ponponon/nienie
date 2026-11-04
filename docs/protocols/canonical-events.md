# 统一 Agent 事件协议

手机端只消费 Nienie 统一事件，不直接消费 OpenCode 或 Codex 原始事件。

## 事件信封

```json
{
  "version": 1,
  "eventId": "evt_123",
  "machineId": "machine_123",
  "agentId": "opencode",
  "sessionId": "session_123",
  "sequence": 42,
  "timestamp": "2026-11-03T12:00:00Z",
  "type": "text_delta",
  "payload": {}
}
```

## MVP 事件类型

### `status`

```json
{
  "type": "status",
  "payload": {
    "status": "running",
    "detail": "正在执行任务"
  }
}
```

### `text_delta`

```json
{
  "type": "text_delta",
  "payload": { "delta": "你好" }
}
```

### `thinking_delta`

```json
{
  "type": "thinking_delta",
  "payload": { "delta": "正在分析项目结构" }
}
```

### `tool_use`

```json
{
  "type": "tool_use",
  "payload": {
    "toolCallId": "call_123",
    "name": "Bash",
    "input": { "command": "npm test" }
  }
}
```

### `tool_result`

```json
{
  "type": "tool_result",
  "payload": {
    "toolCallId": "call_123",
    "content": "Tests passed",
    "isError": false
  }
}
```

### `usage`

```json
{
  "type": "usage",
  "payload": {
    "inputTokens": 100,
    "outputTokens": 200,
    "costUsd": 0.01
  }
}
```

### `error`

```json
{
  "type": "error",
  "payload": {
    "code": "AGENT_EXECUTION_FAILED",
    "message": "Agent 执行失败",
    "retryable": true
  }
}
```

## 设计要求

- 事件必须可按 `sequence` 排序和去重。
- 客户端重连后可以从最后确认的序号继续请求事件。
- 原始 Agent 的密钥、完整环境变量和不必要的敏感内容不能进入事件。
- 大型工具输出必须限制大小并支持分页或单独拉取。
- `tool_use` 和 `tool_result` 必须通过 `toolCallId` 关联。
