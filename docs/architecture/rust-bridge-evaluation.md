# Rust Bridge 评估与渐进迁移方案

## 1. 背景与目标

Nienie 当前的 Bridge 核心（`@nienie/bridge-core`）与适配器（`packages/agent-adapters/*`）基于 Node.js 22 + TypeScript 实现，可同时嵌入 Electron 主进程或以 `HeadlessBridgeDaemon` 无 GUI 守护进程模式独立运行。

本评估旨在明确何时以及如何将 Bridge 迁移至独立 Rust 二进制，同时确保手机端（Flutter）与公网 Relay 协议零破坏性变更。

## 2. Node.js Bridge 与 Rust Bridge 对比

| 维度 | Node.js Bridge (`@nienie/bridge-core`) | Rust Bridge (`tokio` + `tokio-tungstenite`) |
|---|---|---|
| 空闲常驻内存 (RSS) | ~45–70 MB | ~6–12 MB |
| 冷启动耗时 | ~80–150 ms | <10 ms |
| 二进制分发体积 | 需捆绑 Node 运行时 (~80 MB) 或依赖系统 Node | 单一静态二进制 (~5–8 MB) |
| Agent SDK 生态复用 | 可直接复用 TypeScript/JS SDK 与 OpenAPI 生成类型 | 需维护 `serde` 结构体映射 |
| 加密与 WebSocket 吞吐 | Node `crypto` (`AES-256-GCM`) 单核 >30k msg/s，完全满足单人多会话需求 | `ring`/`aes-gcm` 极低延迟，适合高并发多租户 Relay |

## 3. 评估结论

1. **客户端本机 Bridge 阶段**：本地 Bridge 同时连接的移动设备通常为 1–3 台，瓶颈在于底层 LLM 流式输出速率（数十 token/s），Node.js 22 零外部依赖实现已具备毫秒级响应与极高可维护性，短期无需重写本机适配器。
2. **优先迁移模块（第一阶段：公网 Relay）**：公网 Relay（`RelayServer`）只处理 `relay.register`、`relay.presence` 与不透明 `relay.forward` 密文路由，状态模型极简且对内存敏感，最适合优先用 Rust (`axum` + `tokio`) 替换为单二进制容器。
3. **次优迁移模块（第二阶段：Linux 轻量守护进程）**：在低配云服务器（如 1–2 GB RAM 开发机）上常驻运行时，可将 `HeadlessBridgeDaemon` 协议层用 Rust 实现，通过 Wire Protocol v1 与现有 Flutter 客户端无缝互通。

## 4. 协议兼容约束

无论 Bridge 运行在 Node.js 还是 Rust 上，必须严格遵守以下不可变契约：

- `PROTOCOL_VERSION = 1`
- 二维码配对 URI 格式：`nienie://pair?data=<base64url>`
- 端到端加密算法：`AES-256-GCM`，密钥派生 `SHA-256("nienie-relay-v1:" + sharedSecret)`
- 统一事件信封：`CanonicalAgentEvent`（按每个会话单调递增 `sequence`）
