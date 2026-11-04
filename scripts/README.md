# Scripts

这里存放 Nienie 的开发、测试和协议校验脚本。

脚本应保持可重复执行，不得把本机绝对路径、密钥或真实 Agent 会话数据提交到仓库。

## 可用脚本

- `pnpm verify`（`node scripts/verify-all.mjs`）：一键运行全仓 TypeScript 类型检查、Bridge/Adapter/Relay/Desktop 单元与端到端测试、以及 Flutter 手机端静态分析与测试。
