# OpenCode 消息编辑恢复

消息编辑只替换当前 Thread 关联的会话历史。OpenCode Adapter 使用原生 Fork 在指定消息之前派生独立 Session；保留源 Session 和当前工作区文件。移除聊天记录不会撤销已经发生的文件修改。

- 派生候选必须具有不同 Native Session ID，精确保留输入、输出、结果及文件修改记录。Model、Thinking 和 Permission Mode 随候选持久化，包括编辑第一条消息后暂不重发便退出的情况。
- 源会话忙、文件历史尚不完整、内容被并发修改、配置或身份不一致时，编辑失败。原始记录仍是恢复依据；不伪造空历史或继续使用不可信候选。
- 取消确认表示原生执行收到请求。Adapter 等到 native idle 后才发出 Turn 终态，使后续输入沿上游的取消→终态→新 Turn 路径执行。若取消时原生没有写入 Assistant 终态，当前取消可结束，但冷读仍如实显示原生历史的 unknown 状态，不制造持久检查点。

真实 CLI 验证通过显式命令运行隔离 Gate；不同原生版本、Windows、远端共享服务或第三方客户端的并发行为需分别验证。

运行定向原生验证：先 `npm run build:typescript`，再设置 `CODEXHOST_OPENCODE_REAL_COMMAND` 为待测 CLI 路径，运行 `packages/adapters/opencode/test/opencode-adapter.rollback.real.test.ts` 和 `tools/gate-opencode/cancel.real.test.mjs` 对应的 Vitest 用例。它们不接入真实模型账号。
