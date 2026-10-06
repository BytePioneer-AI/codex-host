# OpenCode 消息编辑恢复

消息编辑只替换当前 Thread 关联的会话历史。OpenCode Adapter 使用原生 Fork 在指定消息之前派生独立 Session；保留源 Session 和当前工作区文件。移除聊天记录不会撤销已经发生的文件修改。

- 派生候选必须具有不同 Native Session ID，精确保留输入、输出、结果及文件修改记录。Model、Thinking 和 Permission Mode 随候选持久化，包括编辑第一条消息后暂不重发便退出的情况。
- 源会话忙、文件历史尚不完整、内容被并发修改、配置或身份不一致时，编辑失败。原始记录仍是恢复依据；不伪造空历史或继续使用不可信候选。
- 取消确认表示原生执行收到请求。Adapter 等到 native idle 后才发出 Turn 终态；v1 的 prompt_async 在原生 User Message 发布前即可返回，此时的 idle 不作为取消完成证据，若取消先于执行开始则在首次 busy 时补发 abort，使后续输入沿上游的取消→终态→新 Turn 路径执行。v1 若没有写入 Assistant 终态，冷读仍如实显示 unknown；v2 使用持久化 idle 的 succeeded/failed/interrupted 结果，不以 Assistant finish 字段推断整个执行结束。
- v2 被中断的文本块可能只推送了 transient delta，尚未写入 durable text.ended；完成与冷读快照采用原生落盘内容，可能不保留所有已显示的部分文本。
- v1/v2 均可能在 Fork 时重建消息/Part ID；比较派生历史时忽略这些 Session 内身份，但不能忽略输入、结果或 patch 的变化。源历史本身仍按完整身份校验。
- v2 Session locator 记录 protocol: 2。旧 v1 引用保持不变；跨主版本恢复会被拒绝，不自动迁移。详见[双版本接入](opencode-harness-integration-analysis.md#双版本接入与维护范围)。

真实 CLI 验证通过显式命令运行隔离 Gate；不同原生版本、Windows、远端共享服务或第三方客户端的并发行为需分别验证。

运行定向原生验证：先 `npm run build:typescript`，再设置 `CODEXHOST_OPENCODE_REAL_COMMAND` 为待测 CLI 路径，运行 `packages/adapters/opencode/test/opencode-adapter.rollback.real.test.ts` 和 `tools/gate-opencode/cancel.real.test.mjs` 对应的 Vitest 用例。它们不接入真实模型账号。
