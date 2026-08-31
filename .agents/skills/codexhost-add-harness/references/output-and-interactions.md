# 输出、Item 与 Interaction

本文说明 Adapter 如何把原生 Agent 行为转换为 `HarnessOutput`。权威类型位于 `packages/harness-adapter/src/text-session.ts`，投影约束位于 `packages/protocol-core/src/codex-ui-projector.ts`。

## 输出流

`HarnessSession.outputs` 是单消费者、有序的异步流。建议使用 `HarnessOutputChannel`。

输出分为：

- `{ kind: "event", event }`：Session、Turn、Item 和 Subagent 状态变化；
- `{ kind: "interaction", interaction }`：等待 Desktop 回答的 Approval 或 Question。

顺序是公共契约的一部分。Host 会验证事件引用的 Turn、Item 和 Interaction 是否已经存在及是否仍处于活动状态。

## 标准 Turn 生命周期

成功接受的普通 Turn 应遵循：

```text
turn.started
  → item.started
  → item.updated（零次或多次）
  → item.completed
  → turn.completed
```

一个 Turn 可以有多个并行或交错 Item，但必须满足：

- `turn.started` 只出现一次；
- Item ID 在该 Turn 中唯一；
- `item.updated` 和 `item.completed` 只能引用已开始且未完成的 Item；
- 每个 Item 最多完成一次；
- 所有 Interaction 关闭、所有 Item 完成后才能发 `turn.completed`；
- 每个被接受的 Turn恰好有一个 `turn.completed`；
- Turn 终态后不能继续发该 Turn 的 Item 事件。

Turn 在 `execute()` 返回失败前不得发任何事件。`execute()` 返回成功后，完成可以异步发生。

## Item 类型

### `agentMessage`

用于 Agent 对用户可见的文本：

- 流式文本用 `text.append`；
- 初始文本为空时，Host 可以等第一段文本再向 Desktop 开始 Item；
- `item.completed.snapshot.item.text` 必须与所有 append 后的完整文本一致；
- 最终答案和希望委派观察看到的进度必须是该类型。

### `reasoning`

只投影原生系统明确提供的可见 Reasoning 或摘要，不推断隐藏推理。用 `text.append` 流式更新。

### `commandExecution`

用于明确的 Shell/命令执行：

- `command` 是可展示命令；
- 可提供 `cwd`、输出、截断、退出码和时长；
- 流式输出用 `output.append`。

### `toolExecution`

用于非 Shell 的通用工具：

- 提供稳定 `toolName`、可选 `namespace` 和结构化参数；
- 输出由文本或图片组成；
- 完整替换输出使用 `output.replace`；
- 设置输出大小上限并标记 `truncated`。

### `fileChange`

用于实际文件变化：

- 每项包含路径、add/update/delete 和 unified diff；
- 多次修正使用 `fileChanges.replace`；
- 不要把普通工具描述误投影为文件变化。

### `contextCompaction`

用于原生上下文压缩。它可以来自自动压缩或 Harness Command，但仍按普通 Item 生命周期完成。

### `subagentDelegation`

用于原生 Harness 自己创建的 Subagent，不是 codexhost 跨 Harness 委派记录：

- `operation` 为 spawn 或 send；
- 每个 Subagent 提供状态、描述、是否后台运行和可选结果摘要；
- 状态集合变化使用 `subagents.replace`；
- 详细语义优先参考 OMP，其次 Claude Code。

## Item 和 Turn outcome

Item outcome 与 Turn outcome 分开：

- 某个 Tool 可以失败，而 Agent 处理失败后让 Turn 成功；
- Turn outcome 应反映原生 Turn 的最终状态；
- 取消映射为 `cancelled`，不要伪装为普通失败；
- 原生错误必须转换为 `HarnessError`；
- 在 `turn.completed` 前完成所有仍活动的 Item。

## Approval

Approval 通过 `HostApprovalInteraction` 表达：

- 必须属于当前活动 Turn；
- `interactionId` 唯一；
- 至少提供 allow-once 和 deny 的可映射行为；
- 原生系统支持时可提供 session 或 always scope；
- Action ID 是 Adapter 与原生响应之间的稳定映射，不应直接使用不受控展示文本；
- 使用 `validateHostApprovalResponse()` 验证 Host 响应；
- 原生确认响应后发 `interaction.closed`；
- Turn 取消、Session fault、超时或关闭时也必须关闭 Interaction。

参考 Claude Code 的完整 scope 映射；原生 Host RPC 可参考 DeepSeek Harness；ACP Permission 可参考 Grok。

## Question

Question 通过 `HostQuestionInteraction` 表达，支持：

- 单选或多选 `choice`；
- 单行、多行或 secret `text`；
- 必填、可选、自由输入、placeholder 和 prefill；
- 一个 Interaction 中多个问题。

规则：

- 使用 `validateHostQuestionResponse()`；
- 取消响应不能同时包含答案；
- 非 optional 问题必须有答案；
- 单选和文本问题不得返回多个值；
- `allowOther` 为 false 时只能返回已声明选项；
- 原生系统只支持一种简单输入时，应收窄公共 Question，而不是假装支持全部结构。

参考 Claude Code 和 DeepSeek Harness 的完整 Question；简单确认和文本输入可参考 Pi。

## Interaction 生命周期

```text
Turn 已开始
  → 输出 kind=interaction
  → Host 返回 interaction.respond
  → Adapter 验证并调用原生响应
  → event interaction.closed
  → Item/Turn 才可完成
```

`interaction.closed.reason` 应准确使用：

- `responded`
- `cancelled`
- `expired`
- `superseded`

重复、迟到或引用其他 Session 的响应返回 `invalidState` 或 `invalidRequest`，不能错误路由到当前 Interaction。

## Session 状态、Usage 和 Fault

这些事件不进入普通 Turn projector：

- `session.state.changed`：完整已确认配置；Host 同时持久化 Native identity。
- `session.usage.changed`：完整 Usage 替换。
- `session.faulted`：Session 级不可恢复故障。

发生 fault 时：

1. 关闭所有 Interaction；
2. 完成或失败所有活动 Item；
3. 以失败终结活动 Turn；
4. 发唯一 `session.faulted`；
5. 结束输出流并关闭 Transport。

## Autonomous Turn 和 Subagent 通知

原生 Agent 可能在没有 Host `turn.start` 的情况下继续工作。只有声明 `autonomousTurns.observe` 时才能用 `turn.autonomous.started`：

- Adapter 创建新的 Host Turn ID；
- 提供原生可见输入，没有输入时使用空数组；
- 后续使用普通 Item 与 Turn 生命周期；
- 不能与另一个活动 Turn 重叠。

Subagent Transcript 或状态变化可独立发：

- `subagent.transcript.changed`
- `subagent.state.changed`

这些事件用于刷新已经物化的只读 Subagent Thread。Adapter 只有在可以稳定定位原生 Subagent 时才应声明相关能力。

## 验证重点

至少测试：

1. 成功、失败、取消和 fault 的完整事件顺序。
2. 被拒绝的 Turn 无输出。
3. 并发 Turn 不破坏活动生命周期。
4. 每种受支持 Item 的 start/update/complete 对齐。
5. Tool 失败与 Turn 结果相互独立。
6. Approval 和 Question 的合法、非法、重复、取消和过期响应。
7. 关闭和 fault 会先关闭 Interaction，再结束 Turn。
8. Autonomous Turn 和 Subagent 事件不会与普通 Turn 冲突。
9. Tool Output 与 File Diff 的大小限制和截断标记。
10. 最终 Agent Message 可在实时投影和历史快照中一致读取。
