## MODIFIED Requirements

### Requirement: Protocol Core 必须通过原生 Codex Notification 投影当前 Usage

Protocol Core MUST 独占从规范化 `HostUsage` 到当前 Codex app-server `thread/tokenUsage/updated` Notification 的转换。Notification MUST 携带准确的外部 Host Thread ID、关联的活动或最近已完成 Host Turn ID，以及包含`total`、`last`和`modelContextWindow`的协议有效`tokenUsage`对象。可靠且完整的`contextUsedTokens/contextWindowTokens`字段对 MUST 足以构造当前上下文表盘carrier；当Session aggregate可用时`total` MUST投影其可靠字段，当aggregate不可用时Protocol Core MUST只在Codex专用carrier中生成全零的必填`total` breakdown占位，且 MUST NOT把占位回写`HostUsage`或声称Native Session累计量为零。Host MUST NOT 通过任意通用 Renderer Request method 暴露原始 `HostUsage`；Host MAY 通过一个固定、严格校验且仅按 External Thread ID 读取当前内存快照的 Usage inspection contract，向 Renderer 投影浏览器安全的可选 Usage 字段。

#### Scenario: 外部 Thread 具有完整且可投影的 Usage

- **WHEN** Host 收到完整且可投影的 Usage 快照，该快照关联的 Turn 已满足 Response 顺序门禁
- **THEN** Protocol Core MUST 为该 Thread 和 Turn 创建一个 `thread/tokenUsage/updated` Notification
- **AND** Codex 专用字段名 MUST 保持在 Harness Adapter 和 Pi Adapter 之外

#### Scenario: External Thread Usage inspection returns a current browser-safe snapshot

- **WHEN** Renderer invokes the fixed Usage inspection contract with a known External Thread ID
- **THEN** Host MUST return only the latest in-memory normalized Usage snapshot for that Thread
- **AND** the response MUST omit unknown fields and MUST NOT expose native Harness payloads, Transcript content, credentials, or persisted Usage history

#### Scenario: Usage inspection does not become a generic Host query channel

- **WHEN** Renderer invokes the Usage inspection contract with an official Thread ID, an unknown Thread ID, malformed parameters, or any other method name
- **THEN** Host MUST return an unavailable/validation error without exposing arbitrary Host Runtime state
- **AND** existing official request forwarding and External Thread routing MUST remain unchanged

#### Scenario: 外部 Thread 只有可靠上下文字段对

- **WHEN** Host收到包含可靠上下文字段对但没有Session aggregate的快照，且关联Turn已满足Response顺序门禁
- **THEN** Protocol Core MUST使用真实context used和window构造`last`与`modelContextWindow`
- **AND** 协议必填`total` MUST为全零carrier占位，规范化快照仍 MUST保持aggregate未知

#### Scenario: Usage 缺少可投影的上下文字段对

- **WHEN** 快照缺少上下文窗口已用 Token 或最大 Token 中任意一项，或无法关联活动/最近 Host Turn ID
- **THEN** Host MUST 保留其他仍有用的内部 Telemetry，并 MAY return it through the fixed Usage inspection contract
- **AND** Host MUST 省略 Codex Notification
- **AND** Host MUST NOT 虚构 Turn ID、最大窗口或精确 breakdown

#### Scenario: Usage 早于 Turn 接受 Response 到达

- **WHEN** 原生早期 Telemetry 在 Host 写出对应 `turn/start` Response 之前入队
- **THEN** Host MUST 通过现有 response-before-notification 门禁暂存 Codex Usage Notification
- **AND** the fixed Usage inspection contract MUST expose only the already committed current snapshot

#### Scenario: 恢复后读取 Thread

- **WHEN** `thread/read` 恢复一个具有当前 Usage 和至少一个已对齐 completed Turn 的外部 Thread
- **THEN** Host MUST 先写出读取 Response，再发布最新 Usage Notification
- **AND** the fixed Usage inspection contract MUST return the same current in-memory snapshot without requiring a new Turn
- **AND** 再次访问该 Thread 时 MUST NOT 要求执行新 Turn 才能恢复其上下文表盘
