# Harness 运行中调整

Desktop 的「调整」按当前 Session 能力发送。调整输入目前只支持文本，不回滚文件，也不删除已经执行的历史。

| Harness | 交付方式 | 结束边界 |
| --- | --- | --- |
| 官方 Codex | 保留原生 `turn/steer` | 官方处理 |
| OpenCode | 同一 Host Turn 内原生 steer | 沿用 #158 的版本能力声明；已验证 1.18.25 |
| Pi | 中断后在原 Session 开新 Turn | RPC abort 收据及 agent settled 状态 |
| OMP | 中断后在原 Session 开新 Turn | abort、agent end 与非 streaming 状态 |
| Claude Code | 中断后在原 Session 开新 Turn | SDK 终态；强制取消及后台子任务场景等待所属 Transport 关闭 |
| Grok | 中断后在原 Session 开新 Turn | ACP cancel 后原 session/prompt 终态与输出排空 |
| DeepSeek Modern / Legacy | 中断后在原 Session 开新 Turn | Session cancel 后的原生 Turn 终态 |
| Antigravity | 暂不声明支持 | CLI 退出不能证明共享 Language Server 的执行已结束；中断缺少 final result 时也没有可靠的历史 Turn 引用 |

Pi、OMP 和 DeepSeek 的原生接口可提供更强的 steering 能力，但现有 Adapter 的原生消息关联、逻辑 Turn 分组与冷恢复尚未支持这种语义。本次使用可保留两个真实 Turn 的中断续发；后续验证原生历史分组后可独立提升各 Adapter 的能力。

## 公共契约

`HarnessSessionCapabilities.activeTurns` 保留 `steer: boolean`，增加可选 `interruptAndContinue: boolean`。缺失等价于不支持。Adapter 声明后必须保证：成功或取消终态可作为下一次 prompt 的执行边界；取消收据本身不是边界。无法确认停止时应失败或 fault，不能先报告取消成功再在后台关闭旧执行。

外部 Thread 的 `codexhost/thread/inspect` 返回当前 Session 的 `activeTurns`。新增请求 `codexhost/turn/adjust`：

```json
{
  "threadId": "external-thread-id",
  "expectedTurnId": "active-turn-id",
  "clientUserMessageId": "stable-client-message-id",
  "input": [{ "type": "text", "text": "请优先验证取消逻辑" }]
}
```

结果包含 `turnId`、`previousTurnId` 和 `delivery`（`steer` 或 `interrupt-and-continue`）。原生 steer 优先。官方请求继续经过原来的 `turn/steer`；此扩展接口仅接受外部 Thread。

Host 在取消期间保留 Session access，阻止新 prompt、历史刷新和历史替换抢入。唯一输出消费者完成旧 Turn 的终态投影后，才建立新 Turn；顺序为旧 Turn 输出及结束、调整响应、新 Turn 开始和 userMessage 事件。配置操作仍遵循原有 Adapter 约束；如果交接时 Session 仍忙，调整会失败。

每个 Session 同时只允许一个中断续发事务。相同 client identity 和输入复用结果，冲突输入拒绝。结果缓存在当前 Session 内，超过缓存上限的旧 identity 由 stale Turn 校验拒绝；跨 Host 重启不承诺结果缓存。不能在请求结果未知时换 identity 自动重放。

取消失败、等待终态超过 30 秒、输出结束、Session fault、持久化失败或 Host 关闭时，不启动续发。请求超时或被停止时，尚未返回的原生取消仍持有 Session access，防止迟到的取消影响后续 prompt。新 prompt 已开始 admission 后，停止操作会在 admission 返回后取消新 Turn；无法确认 admission 的异常保留投影和占用，让迟到输出可见，禁止自动重放。

## Desktop 状态与历史

Desktop 自带的 steeringUserMessage 绑定旧 Turn；旧 Turn 结束时会把未消费消息恢复为待发送输入。请求桥只对明确声明中断续发的外部 Session，且能够识别原生乐观消息时转交调整：先取出旧 Turn 的乐观消息，再发新接口；失败时恢复原对象，保留 restoreMessage 供 Desktop 原生错误恢复使用。

已观察并覆盖 `turns` 和 canonical `turnHistory` 两种状态。未知状态在取消前失败。新 Turn 通过正常 item/started、item/completed 展示实际 userMessage 和 clientId，避免只在 turn/started 的 items 中携带输入而被 Desktop 忽略。

中断续接的 Turn 由 Host 发起，Desktop 默认给它空的 `params.input`；显示 userMessage 并不会填回编辑器使用的输入。请求桥在确认调整响应的 Turn 身份后，将已提交的文本和 client identity 写入该 Turn 的空输入。响应先到时等待对应的 Turn/item 通知，通知先到时直接补齐，已有输入不覆盖。关闭 Thread 或卸载请求桥时清理待同步输入，避免后续编辑发送空的 `turn/start`。

运行中调整与已发送消息的编辑是独立能力。Codewiz 已实现最后一轮回退；Claude Code / Codewiz CC 仍声明 `rollbackLastTurn=false`，因此支持运行中调整，但不支持铅笔编辑历史消息。不能以调整可用推断历史编辑可用。

中断续发保留旧 Turn 和新 Turn。它不需要 rollback 或另建 Native Session；映射继续使用原生历史。当前交付以协议、Adapter fixture 和 Renderer 状态测试为验证范围，不能据此声称全部 Harness 版本都经过真实运行验证。

## PR #155 的整合边界

[PR #155](https://github.com/BytePioneer-AI/codex-host/pull/155) 实现的是 DeepSeek Modern `dsh-v0.1.2-rc.1` 的最后一条消息编辑/rollback：多 Turn 在前一个 turn/end 分叉，单 Turn 创建保留 agentPreset 的空 Session，配置序号允许 -1。它可以供后续 DeepSeek 编辑功能参考，不是运行中调整的取消协议。

#158 的历史替换另要求 `history.replacementFence`。当前 Modern Session close 只停止本地 journal 观察，不保证远端任务已停止；仅搬入 #155 的 rollback 开关不能满足这一要求。本次不启用 DeepSeek rollback，不把中断续发依赖到该 PR。
