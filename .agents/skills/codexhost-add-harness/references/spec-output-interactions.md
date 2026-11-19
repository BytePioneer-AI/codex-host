# 输出与交互

对应能力总表：A5–A6、B8–B12。所有插件都必须遵守本页的输出、Turn 和故障规则；Item、Interaction、自主 Turn、Subagent 按原生能力实现。类型以 `packages/harness-adapter/src/text-session.ts` 为准，投影约束可以在 `packages/protocol-core/src/codex-ui-projector.ts` 中核实。

## 一个有序输出流

`HarnessSession.outputs` 是单消费者的异步流，可以复用公共的 `HarnessOutputChannel`：

- `{ kind: "event", event }`：Session、Turn、Item、Usage、Subagent 的变化。
- `{ kind: "interaction", interaction }`：等待用户回答的 Approval 或 Question。

插件负责原生请求/回调的关联和归一化；Host 负责把公共交互关联并投影到 Desktop。不要新增原生事件透传通道，也不要让 Renderer 解释原生 SDK 对象。

## Turn 生命周期

```text
接受 turn.start（被拒绝的调用不输出任何生命周期事件）
  → turn.started
  → item.started
  → item.updated（零次或多次，可与其他 Item 交错）
  → item.completed
  → 所有 Interaction 关闭、所有 Item 终结
  → 唯一的 turn.completed { nativeTurnRef?, outcome }
```

- 「接受」和「完成」是两回事。RPC 请求返回或 SDK 文本结束，不一定代表 Agent 和工具已经全部结束。
- 同一个 Turn 只开始、只完成一次。Item ID 在 Turn 内唯一，更新和完成只能引用活动中的 Item。
- 每个被接受的 Turn 都必须终结，包括失败、取消和关闭的情况；终态之后不再为它发送 Item 更新。
- 完成快照与累计的流式内容一致。原生同时返回 delta 和完整消息时，避免文本重复。
- 工具失败不自动等于 Turn 失败，Agent 恢复后仍可能成功；outcome 以原生最终状态为准。
- 成功的 Turn 需要 `nativeTurnRef`。
- NativeTurnRef 和 checkpoint 的要求见[身份与历史](spec-history.md)。

## 取消与后续 Turn

- `turn.cancel` 返回成功只表示取消已受理，不代表旧轮已经终结。要根据原生能确认的信号关闭旧轮的 Interaction、终结 Item，再发布唯一的终态；不能为了尽快续跑而伪造完成。
- 普通取消要保留可以继续的 Session 和历史，随后能接受新的 `turn.start`；旧轮的回调、输出和取消标记不能污染新轮。如果需要重建原生执行进程，由 Adapter 按原生恢复语义处理。
- 取消无法确认或 Session 已不可用时，按公共错误与故障规则报告。要区分「旧轮已终结」和「原生进程、工具、后台子任务已全部退出」，明确说明仍在运行的部分及其限制。
- Desktop 的「调整方向」复用 `turn.cancel` → 等待旧轮终态 → `turn.start`，插件不需要实现 steer（见 `docs/architecture/external-thread-steering.md`）。

## 原生内容映射

| 原生内容 | 公共 Item | 必须保留的语义 |
|---|---|---|
| 可见回答、需要对外观察的进度 | `agentMessage` | 流式 `text.append`；完成文本与累计内容一致。能区分进度和最终回答时设置 `phase: "commentary" \| "final_answer"`；不能区分时省略，由 Host 把成功 Turn 的最后一条消息视为最终回答 |
| 原生明确公开的 Reasoning 或摘要 | `reasoning` | 只转换原生公开的内容，不推测隐藏推理 |
| Shell / 明确的命令 | `commandExecution` | 命令、适用的 cwd、输出（`output.append`）、退出码/时长、截断标记 |
| 其他工具 | `toolExecution` | 名称、可选 `namespace`、结构化参数、文本/图片输出（`output.replace`）及实际结果 |
| 实际的文件修改 | `fileChange` | 路径、add/update/delete、unified diff；局部片段用 `diffScope: "fragment"`；原生结果覆盖工具预览时用 `sourceItemIds` 指向被覆盖的工具 Item |
| 自动或手动压缩 | `contextCompaction` | 与普通 Item 一样有开始和终态；只有原生确认的压缩才算，普通的 `/compact` Prompt 不算 |
| 原生 Harness 的子 Agent 调用 | `subagentDelegation` | spawn/send、稳定的子身份、状态、后台标记、原生 Model/effort（仅在已知时填写）、结果摘要；更新用 `subagents.replace` |

为工具输出和 diff 设置合理的上限，使用类型支持的截断标记，不无限缓存流。最终结果以及需要被委派方观察的文本使用 `agentMessage`；不要把 Reasoning 或工具输出提升为最终回答。

## 双向 Interaction

### Approval

使用 `HostApprovalInteraction`。actions 只表达能映射到原生决策的 effect：`allowOnce`、`allowForSession`、`allowAlways`、`deny`。session 和 always 范围只在原生确实支持时提供，不把「允许一次」升级为永久授权。

先用公共的 `validateHostApprovalResponse()` 校验 action，再调用原生决策回调，然后发布对应的关闭事件。action ID 到原生决策的映射由插件负责；展示文本不能当作不受校验的协议 ID。

### Question

使用 `HostQuestionInteraction`，按原生的表达能力选择字段：choice 或 text、多选、`allowOther`、optional、secret、placeholder/prefill。不声称支持原生无法接受的答案形式。

使用 `validateHostQuestionResponse()` 校验必填项、选项范围、单值/多值和取消语义。取消不能同时携带答案；secret 答案不写入诊断。

### 共同生命周期

```text
活动 Turn → interaction 输出 → Host execute(interaction.respond)
  → 校验 Session、Interaction 和回答 → 原生处理响应 → interaction.closed
```

- Interaction ID 唯一，且属于当前活动上下文。迟到的、重复的、跨 Session 的或类型不对的响应都要明确拒绝。
- 关闭原因用 `responded`、`cancelled`、`expired`、`superseded`；`expiresAt` 只在原生有超时的情况下设置，不把超时说成用户回答。
- Turn 取消、超时、Session fault 和 close 都要关闭待处理的交互，并解除原生侧的等待。
- 响应失败与取消发生竞态时，不能把答案交给下一次交互；每个交互只关闭一次。
- 原生没有审批，不代表要伪造审批 UI；原生确实有交互，也不能退化成普通文本或自动作答。

## Session 状态、Usage 与故障

state 和 Usage 事件是 Session 级别的完整状态，不是普通 Item，可以独立于 Turn 更新。字段要求见[会话核心](spec-session-core.md#配置与状态requested-不等于-effective)和[用量与账号](spec-usage-accounts.md)。

不可恢复的 Session fault 按以下顺序处理：

1. 关闭待处理的 Interaction，终结活动 Item。
2. 如果有活动 Turn，发出它唯一的失败终态。
3. 发布唯一的 `session.faulted`，结束输出流，关闭原生资源。

close 同样必须终结活动中的生命周期，并且幂等。可恢复的单次操作失败不应无条件升级为 Session fault。fault 之后，Host 会通过 resume 重建 Session，因此 fault 不能破坏原生历史。

## Autonomous Turn 与原生 Subagent

原生可能在没有 Host `turn.start` 的情况下产生输出。能完整观测时声明 `autonomousTurns.observe`：用 `turn.autonomous.started` 分配公共 Turn 身份并提供原生可见的输入（没有输入时用空数组），之后遵循普通的 Item/Turn 规则，不能与另一个活动 Turn 混写。不能只因漏声明能力就丢弃原生的后台结果；如果暂时无法安全投影自主行为，记录限制并处理相关的原生模式。

Subagent 的 `observe` 和 `readTranscript` 分别声明。原生后台子任务可以在父 Turn 终态之后继续运行：使用稳定身份，通过 `subagent.state.changed` / `subagent.transcript.changed` 通知，而不是向已完成的父 Turn 追加 Item。支持读取 Transcript 时，实现 `adapter.subagents.readSnapshot({ parent, nativeSubagentId, cwd })`。参考 Pi（pi-subagents）、OMP（需订阅原生事件）、Grok、Antigravity。

原生 Subagent 不等于 codexhost 的跨 Harness 委派，后者见[委派](spec-delegation.md)。

## 验收

- 成功、失败、取消、fault、close 的完整事件顺序；被拒绝的 Turn 没有输出；重复开始和迟到事件不会污染下一轮。
- 取消：取消确认与终态的先后顺序、取消后立即开始下一轮、取消失败或超时、迟到输出的隔离；分别覆盖流式输出、工具运行中和有待处理 Interaction 的情况。
- 每种受支持的 Item 的 start/update/complete、交错、内容一致性和输出上限。
- 原生工具失败后 Agent 恢复，最终 Turn outcome 仍然正确。
- Interaction 的合法、非法、重复、过期和取消响应，以及响应与关闭的竞态。
- 如果支持：自主 Turn、后台 Subagent 与普通 Turn 不串用身份、不吞事件、不破坏唯一终态。
- 同一个最终回答在实时投影和只读历史中都能看到，且一致。
