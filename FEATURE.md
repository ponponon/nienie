# 功能记录

本文档记录 Nienie 已实现和规划中的产品功能，确保未来更换开发者或 AI 后，可以从零理解并重建项目。

## 已完成

### 2026-11-03 项目初始化

- 确定产品名称：Nienie / 捏捏
- 确定产品定位：移动优先的本地 AI 编程 Agent 控制台
- 确定手机端使用 Flutter，目标为 iOS 和 Android
- 确定电脑端使用 Electron + React + TypeScript
- 确定 Bridge 使用 Node.js + TypeScript，并先嵌入 Electron 主进程
- 确定初版 Agent 范围为 OpenCode 和 Codex
- 确定后续扩展路线包含 Claude Code、Pi、OpenClaw、ACP Agent 和其他本地 Agent
- 建立统一事件协议和适配器架构文档
- 建立 TypeScript workspace、统一协议包和 Bridge 核心骨架
- 建立 OpenCode/Codex 适配器接口和 Electron 组合入口
- 增加可替换公网 Relay 默认配置：`wss://nienie-replay.quniv.cn`

## MVP 规划

- [ ] Electron Bridge 启动和健康检查
- [ ] OpenCode 适配器
- [ ] Codex 适配器
- [ ] 手机与电脑二维码配对
- [ ] 手机会话列表
- [ ] 手机会话详情
- [ ] 流式文本事件
- [ ] 工具调用和工具结果事件
- [ ] 基础状态和错误事件
- [ ] 手机发送 Prompt
- [ ] WebSocket 断线重连
- [ ] 公网 Relay 连接和设备路由
- [ ] 自定义 Relay 地址配置
- [ ] Relay 端到端加密消息转发
- [ ] 基础权限请求展示

## 后续规划

- [ ] 文件变更和 Diff 卡片
- [ ] 模型选择和 Agent 能力展示
- [ ] 会话恢复
- [ ] 多台电脑管理
- [ ] ACP 适配器
- [ ] PTY/TUI 兜底模式
- [ ] 完整远程桌面兜底
- [ ] iOS 和 Android 推送通知
- [ ] Bridge 独立后台进程
- [ ] Linux 无 GUI 模式
- [ ] Rust Bridge 评估和迁移

## 后续 Agent 适配路线

- [ ] Claude Code 结构化流适配
- [ ] Pi RPC 适配
- [ ] 通用 ACP 适配器
- [ ] OpenClaw Gateway 适配
- [ ] 其他 JSONL / HTTP Agent 适配
- [ ] PTY/TUI 通用兜底适配
