## Context

现有Claude Adapter持有一个长期SDK `Query`，但私有transport只暴露Turn、Interaction、Abort和close。SDK `0.3.220`的稳定`Query.getContextUsage()`返回当前上下文`totalTokens`和`maxTokens`；它不要求使用明确标为experimental的Session totals API。现有Protocol projector已经用`tokenUsage.last`和`modelContextWindow`驱动Codex表盘，但额外要求`HostUsage.totalTokens`，导致可靠context-only快照无法投影。

## Goals / Non-Goals

**Goals:**

- 在Claude Turn终态后从活动Query读取并严格校验当前context pair。
- 通过现有`session.usage.changed`输出发布快照，读取失败不影响生命周期。
- 让context-only快照构造协议有效的Codex原生Usage通知。

**Non-Goals:**

- 不依赖`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`。
- 不把单Turn SDK Result Usage误写成Session aggregate，不增加模型、百分比或分类明细契约。
- 不为resume或空create仅因Usage启动Claude进程，不改变Claude开发开关与发布范围。
- 不增加Renderer控件、轮询、Usage持久化或Host中的Claude分支。

## Decisions

### 1. Transport只暴露规范化前的最小context pair

`ClaudeTurnTransport.getContextUsage()`返回私有的`usedTokens/maxTokens`结构或`null`。`ClaudeSdkTransport`调用当前Query的稳定API，接受非负safe integer的used和正safe integer的max；无活动Query返回`null`，malformed响应抛错。SDK payload、模型名、percentage和分类breakdown不离开Adapter包。

选择Turn终态后读取，而不是解析Result Usage，因为Result字段scope不是当前Session上下文契约。选择不在`open(resume)`启动Query，保持现有lazy和“不得仅为Usage启动进程”的公共要求。

### 2. Adapter异步刷新并隔离失败与过期结果

每个Turn开始使上一刷新generation失效；Turn到达terminal后异步读取context，校验并通过有序输出流发布完整`HostUsage`替换快照。新Turn、close或fault使迟到结果失效。读取失败保留最近可靠值或`null`，不修改Turn outcome、Session phase或close等待。

### 3. Context pair足以构造Codex表盘carrier

Protocol projector仍要求真实Host Turn ID及完整context pair。`tokenUsage.last.totalTokens/inputTokens`使用真实context used，`modelContextWindow`使用真实max。若Harness没有Session aggregate，协议必填`tokenUsage.total`使用全零breakdown作为Codex专用carrier占位；若有可靠aggregate则保持现有投影。占位不写回`HostUsage`，也不对外承诺Session total为零。

这是现有未知breakdown字段零填充策略的有限扩展。替代方案是要求Claude experimental totals，拒绝，因为不稳定API不是圆圈所需事实。替代方案是把context used伪装成Session total，拒绝，因为两者语义不同。

## Risks / Trade-offs

- [Codex未来显示aggregate占位] -> projector测试固定carrier边界；若Desktop开始展示该值，停止context-only通知并重新评审协议。
- [Usage请求晚于下一Turn] -> generation在Turn接受、close和fault时失效旧结果。
- [SDK context读取失败或格式漂移] -> 严格fail closed且不影响Turn。
- [resume重访在首个新Turn前仍无Claude Usage] -> 保留lazy进程约束；本Change不为Telemetry预热Query。
