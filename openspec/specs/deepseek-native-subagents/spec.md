# deepseek-native-subagents Specification

## Purpose

定义 DSH `0.1.2-rc.1` 和 `0.1.5-rc.1` 默认本地子智能体在 CH 中的原生卡片、只读历史、父子所有权、后台生命周期与验证边界，确保展示与原生事实一致。

## Requirements
### Requirement: Exact supported runtimes expose native subagent observation

DSH `0.1.2-rc.1` and `0.1.5-rc.1` Adapters SHALL expose native subagent observation and read-only transcript capability for their default session-backed `subagent` and `subagent_fork`. Unsupported runtimes and remote-only provider internals MUST NOT be presented as supported native child transcripts.

#### Scenario: Default native child is discovered
- **WHEN** the parent starts a supported native child
- **THEN** CH SHALL display a standard collaboration Item with a stable verified child identity, native description and truthful status
- **AND** 012 discovery SHALL work without requiring the 015-only catalog event

#### Scenario: Ambiguous or remote-only tool output
- **WHEN** a tool result does not prove a specific session-backed child identity
- **THEN** the Adapter SHALL retain native tool semantics or use independently verified child catalog facts and SHALL NOT guess a child from order, name alone or a job ID

### Requirement: Child history is read through verified native ancestry

Read-only child access MUST validate the entire native ancestry, runtime profile, durable child header and workspace. Journal follow and history pages MUST use the native subagent address. Stable identities MUST survive repeated reads and Host restart; inherited catalog facts MUST NOT grant a new parent ownership of source children.

#### Scenario: Live and restored child details
- **WHEN** a user opens a running or persisted child
- **THEN** CH SHALL provide actual child input, public text, tools and outcomes with stable Item and Turn identities
- **AND** active streamed text SHALL be available before the child Turn completes
- **AND** reading SHALL neither send a prompt nor activate or cancel a child

#### Scenario: Wrong parent or inherited source child
- **WHEN** a request uses an unrelated parent, malformed handle, different runtime or an inherited ownership claim
- **THEN** the Adapter SHALL reject it with a typed error without reading unrelated child history

### Requirement: Background and nested lifecycle remains observable

Child state and transcript changes SHALL remain observable after the launching parent Turn completes. Completed launch tools MUST NOT imply child completion. Success, failure and interruption MUST follow native terminal evidence, and transient reads MUST NOT manufacture completion. Closed observations MUST release timers, streams and pending reads without cancelling native work.

#### Scenario: Background child settles after parent Turn
- **WHEN** a background child produces output or ends while no parent Turn is active
- **THEN** the Adapter SHALL publish Session-level child notifications and keep parent history consistent without updating completed Items

#### Scenario: Child continues or is interrupted
- **WHEN** native tools send a further message or request interruption
- **THEN** the same child identity SHALL be retained and actual subsequent native status SHALL be observed
- **AND** interruption acknowledgement SHALL NOT be treated as proof of quiescence

#### Scenario: Nested notification and running child open
- **WHEN** a root observer publishes a descendant change or a running child Thread is opened
- **THEN** Host SHALL refresh only the correctly owned descendant and preserve its observed running status
- **AND** other parent trees, Harnesses and replaced Native Sessions SHALL remain isolated

#### Scenario: Parent cancellation and managed shutdown
- **WHEN** a user cancels a parent Turn while a background child runs
- **THEN** the child SHALL continue under its native lifecycle
- **WHEN** the ordinary owning parent Session is explicitly closed, including before its first child observation
- **THEN** the Adapter SHALL stop parent execution, request interruption of owned continuable children, verify native quiescence and persist terminal evidence before releasing the managed connection
- **AND** a rejected or unconfirmed interruption SHALL report failure while still releasing observation resources
- **AND** closing a read-only child observation SHALL NOT invoke this cancellation path

### Requirement: Implementation and documentation share verification evidence

The change SHALL update OpenSpec, affected capability documentation and stale DSH implementation guidance under `.agents`. README files and local planning files MUST remain outside the change. Automated checks MUST cover both supported profiles, negative ownership cases, lifecycle and actual child read paths; coverage and real CLI results SHALL be reported accurately.

#### Scenario: Draft PR is delivered
- **WHEN** implementation and validation finish
- **THEN** the Draft PR SHALL describe completed behavior, checks and native limitations without claiming unperformed Desktop visual verification
