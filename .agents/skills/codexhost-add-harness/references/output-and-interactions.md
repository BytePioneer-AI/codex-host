# 输出与交互

所有插件读取输出、Turn 和故障规则；按原生能力实现 Item、Interaction、自主 Turn 和 Subagent。类型以 `packages/harness-adapter/src/text-session.ts` 为准，投影约束可在 `packages/protocol-core/src/codex-ui-projector.ts` 核实。

## 一个有序输出流

`HarnessSession.outputs` 是单消费者异步流，可复用公共 `HarnessOutputChannel`：

- `{ kind: "event", event }`：Session、Turn、Item、Subagent 变化。
- `{ kind: "interaction", interaction }`：等待用户回答的 Approval 或 Question。

插件负责原生请求/回调关联和归一化，Host 负责公共交互到 Desktop 的关联与投影。不要新增原生事件透传通道或让 Renderer 解释原生 SDK 对象。

## Turn 生命周期

```text
接受 turn.start（拒绝的调用不输出生命周期事件）
  → turn.started
  → item.started
  → item.updated（零次或多次，可与其他 Item 交错）
  → item.completed
  → 所有 Interaction 关闭、所有 Item 终结
  → 唯一 turn.completed
```

- 接受与完成不同；RPC 请求返回或 SDK 文本结束，不一定代表 Agent/工具已完全结束。
- 同一个 Turn 只开始和完成一次；Item ID 在 Turn 内唯一，更新/完成只能引用活动 Item。
- 每个接受的 Turn 都终结，包括失败、取消和关闭；终态后不再为它发 Item 更新。
- 完成快照与累计流式内容一致；原生同时返回 delta 和完整消息时避免重复文本。
- Tool 失败不自动等于 Turn 失败；Agent 恢复后仍可能成功。按原生最终状态决定 outcome。
- NativeTurnRef 和 checkpoint 的要求见[身份与历史](thread-lifecycle-and-history.md)。

## 原生内容映射

| 原生内容 | 公共 Item | 必须保留的语义 |
|---|---|---|
| 可见回答、需要对外观察的进度 | `agentMessage` | 流式 text.append；完成文本与累计内容一致 |
| 明确公开的 Reasoning/摘要 | `reasoning` | 仅转换原生公开内容，不推测隐藏推理 |
| Shell/明确命令 | `commandExecution` | 命令、适用 cwd、输出、退出码/时长、截断信息 |
| 其他工具 | `toolExecution` | 名称、结构化参数、文本/图片输出与实际结果 |
| 实际文件修改 | `fileChange` | 路径、add/update/delete、unified diff；不是工具描述文字 |
| 自动或手动压缩 | `contextCompaction` | 与普通 Item 一样有开始和终态 |
| 原生 Harness 的子 Agent 调用 | `subagentDelegation` | spawn/send、稳定子身份、状态、后台标记和结果摘要 |

按公共 Item 对应 update 类型更新；为工具输出与 diff 设合理边界，使用类型支持的截断标记或明确的受限处理，不无限缓存流。最终结果和需要委派观察的文本使用 agentMessage；不要把 Reasoning/工具输出提升成最终回答。

## 双向 Interaction

### Approval

使用 `HostApprovalInteraction`；actions 只表达能映射到原生决策的 effect。提供明确允许/拒绝行为，session/always 范围仅在原生实际支持时提供，不把“允许一次”升级成永久授权。

使用公共 `validateHostApprovalResponse()` 验证 action，调用原生决策回调，再发布对应关闭事件。插件拥有 action ID 到原生决策的映射，展示文本不是不受校验的协议 ID。

### Question

使用 `HostQuestionInteraction`，按原生表达能力选择 choice/text、多选、自由输入、optional、secret、prefill 等字段，不宣称原生无法接受的答案形式。

使用 `validateHostQuestionResponse()`：校验必填、选项范围、单/多值与取消语义。取消不能同时携带答案；secret 答案不写入诊断。

### 共同生命周期

```text
活动 Turn
  → interaction 输出
  → Host execute(interaction.respond)
  → 验证 Session/Interaction 和回答
  → 原生处理响应
  → interaction.closed
```

- Interaction ID 唯一且属于当前活动上下文；迟到、重复、跨 Session 或类型错误的响应明确拒绝。
- 关闭原因用 responded、cancelled、expired、superseded，不把超时说成用户回答。
- Turn 取消、超时、Session fault 和 close 都关闭待处理交互并解除原生等待。
- 响应失败与取消竞态不能把答案交给下一次交互；每项只关闭一次。
- 原生没有审批并不意味着必须伪造审批 UI；原生确有交互也不能退化成普通文本或自动作答。

## Session 状态、Usage 与故障

state/Usage 事件是 Session 级完整状态，不是普通 Item；字段要求见[公共行为](public-adapter-contract.md)。它们可以独立于普通 Turn 更新。

不可恢复 Session fault 按顺序处理：

1. 关闭待处理 Interaction，终结活动 Item。
2. 如果有活动 Turn，发出其唯一失败终态。
3. 发布唯一 session.faulted，结束输出流，关闭原生资源。

close 同样必须终结活动生命周期且幂等；可恢复的单次操作失败不应无条件升级成 Session fault。普通取消要保留可继续的 Session 和历史。

## Autonomous Turn 与原生 Subagent

原生可能在没有 Host turn.start 的情况下产生输出。能完整观测时声明 `autonomousTurns.observe`，使用 turn.autonomous.started 分配公共 Turn 身份、提供原生可见输入，后续遵循普通 Item/Turn 规则。没有可见输入可为空数组；不能与另一活动 Turn 混写。

不能只因漏声明能力而丢弃原生后台结果；若当前实现无法安全投影自主行为，明确记录限制并处理相关原生模式，不伪装完整支持。

Subagent 的 observe/readTranscript 分别声明。原生后台子任务可在父 Turn 终态后继续，使用稳定身份及 `subagent.state.changed` / `subagent.transcript.changed` 通知，而不是向已完成父 Turn 继续追加 Item。支持 Transcript 时实现 Adapter 的只读 subagents 接口。

原生 Subagent 不等于 codexhost 跨 Harness 委派；后者见[委派清单](cross-harness-delegation.md)。

## 验收

- 成功/失败/取消/fault/close 的完整顺序；被拒绝的 Turn 无输出；重复开始和迟到事件不会污染下一轮。
- 每种受支持 Item 的 start/update/complete、交错、内容一致性和输出边界。
- 原生 Tool 失败后恢复，最终 Turn outcome 仍正确。
- Interaction 合法/非法/重复/过期/取消响应，以及响应与关闭竞态。
- 支持时，自主 Turn、后台 Subagent 与普通 Turn 不串用身份、不吞事件、不破坏唯一终态。
- 同一最终回答在实时投影和只读历史中一致可见。
