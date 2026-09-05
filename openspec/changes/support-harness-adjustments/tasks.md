## 1. 公共调整

- [x] 1.1 增加调整能力、请求/结果 schema 和公共接口文档。
- [x] 1.2 实现 Host 中断续发 reservation、去重、终态等待、停止及错误收敛。
- [x] 1.3 为新 Turn 投影真实输入，并验证旧 Turn、响应与新输出顺序。

## 2. Desktop 与 Adapter

- [x] 2.1 接入 Desktop 请求桥，处理乐观消息转移、原生路径和失败恢复。
- [x] 2.2 核实并接入 Pi、OMP、Claude Code、Grok、DeepSeek 的取消续发边界。
- [x] 2.3 核查 Antigravity 的 Session identity、原生退出和历史边界；未满足的能力保持禁用并记录原因。
- [x] 2.4 核对 #155 的历史语义并记录整合边界。

## 3. 验证

- [x] 3.1 增加 Host、Desktop、Adapter 的聚焦行为和竞态测试。
- [x] 3.2 运行聚焦测试、类型检查、lint、格式与 OpenSpec 验证并同步文档。

验证结果：

- 最后一组 Host、Desktop、Claude SDK/Adapter、公共 schema 与投影测试：8 个文件、364 项通过。
- Pi、OMP、Grok、DeepSeek Modern/Legacy 的相关 Adapter / RPC 用例也已通过。
- `npm run typecheck`、`npm run lint`、变更文件 Prettier 检查、`git diff --check`、OpenSpec strict 验证通过。
- 真实子进程 SIGKILL/退出边界测试通过；尚未逐个 Harness 做真实模型会话或 Desktop 端到端验收。
