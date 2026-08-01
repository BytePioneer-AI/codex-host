## ADDED Requirements

### Requirement: Session Usage 必须共享输出顺序但不成为 Turn 生命周期

文本 Session 契约 MUST 通过 `initialUsage` 和现有单消费者有序输出流上的 `session.usage.changed` 承载规范化 Session Usage。Usage 事件 MUST 是 Session 级 Telemetry，MUST NOT 要求存在活动 Turn，并且 MUST NOT 削弱每个已接受文本 Turn 恰好具有一个 started 事件和一个 terminal 事件的要求。

#### Scenario: Usage 出现在成功文本 Turn 之后

- **WHEN** Adapter 发出 `turn.completed(succeeded)`，随后发布可靠的 Turn 后 Usage 快照
- **THEN** 消费者 MUST 接受后续 Session Usage 事件，且不得把它视为 Turn terminal 之后的 Turn 输出
- **AND** 已完成的 Turn 生命周期 MUST 保持关闭

#### Scenario: 文本 Session 不支持 Usage

- **WHEN** 具体 Harness 不提供可靠的 Usage Telemetry
- **THEN** 其 Session MUST 将 `initialUsage` 暴露为 `null`，并且不发出 Usage 快照
- **AND** 所有现有文本、cancel、state、fault 和 close 行为 MUST 保持不变
