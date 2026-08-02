# harness-adapter-text-session Specification

## Purpose

Define the minimal UI-independent HarnessAdapter text Session contract for lazy create, ordered Agent Message and Turn lifecycles, normalized failures, Host projection, and bounded close without exposing native Harness protocols.

## Requirements
### Requirement: Host uses a UI-independent text Session interface

The system SHALL expose a `HarnessAdapter` that opens a create-mode `HarnessSession`, and the Session SHALL accept text Turn commands and expose Host-semantic outputs without exposing Pi RPC or Codex app-server types.

#### Scenario: Host creates a Pi Session

- **WHEN** Host routing selects Pi for a new Thread
- **THEN** the Host opens a create-mode Session through the `HarnessAdapter` interface
- **AND** the Host does not construct or invoke `PiRpcSession` directly

#### Scenario: Unsupported future operations are absent

- **WHEN** the first text-session contract is published
- **THEN** inspect, catalog, Tool, Interaction, explicit cancel, history, resume, and fork behavior is not represented by placeholder methods

### Requirement: Native process startup is lazy and reusable

Opening a create-mode Pi Session SHALL NOT start a Pi process. The Session SHALL start Pi when the first text Turn is executed and SHALL reuse that process for later Turns in the same Session.

#### Scenario: Unused prewarm Session closes

- **WHEN** a Pi Session is opened and closed without an accepted Turn
- **THEN** no Pi process is created

#### Scenario: Same Session executes multiple Turns

- **WHEN** two sequential text Turns are accepted by one Pi Session
- **THEN** Pi is started once and both Turns use the same Native Session

### Requirement: Accepted text Turns have an ordered complete lifecycle

A Session SHALL expose one single-consumer ordered output stream. Every accepted text Turn SHALL produce exactly one `turn.started` and one `turn.completed`, and every started Item SHALL complete before the Turn terminal event.

#### Scenario: Successful text Turn

- **WHEN** Pi emits text deltas and `agent_settled`, and the subsequent native state readback confirms `isStreaming === false`
- **THEN** outputs contain `turn.started`, Agent Message `item.started`, ordered `text.append` updates, `item.completed`, and `turn.completed(succeeded)` in that order

#### Scenario: Native settlement cannot be confirmed

- **WHEN** Pi emits `agent_settled` but native state remains Streaming, is malformed, or cannot be read back within the RPC Command bound
- **THEN** the started lifecycle SHALL complete exactly once with a failed outcome
- **AND** the Session SHALL emit `session.faulted`

#### Scenario: Accepted Turn fails

- **WHEN** Pi rejects or fails after the Turn has been accepted
- **THEN** the started Agent Message Item completes with a failed outcome
- **AND** the Turn completes exactly once with a failed outcome

#### Scenario: Turn is rejected before acceptance

- **WHEN** Session state, input validation, or Pi startup rejects a Turn before acceptance
- **THEN** the command returns a normalized error
- **AND** no lifecycle output is produced for that Turn

#### Scenario: Concurrent Turn is attempted

- **WHEN** a second Turn is submitted while one Turn is active
- **THEN** the Session rejects it with `sessionBusy`
- **AND** the active Turn lifecycle remains unchanged

#### Scenario: Accepted Turn runs for an extended duration

- **WHEN** an accepted native Turn remains active without a native failure, process exit, protocol fault, cancellation, or Session close
- **THEN** the Session SHALL continue waiting for the native terminal condition
- **AND** elapsed wall-clock time alone SHALL NOT fail the Turn or fault the Session

### Requirement: Session state and faults use the ordered stream

The Session SHALL publish available Native Session identity as a complete state change. An unrecoverable Pi process or protocol fault SHALL complete any active lifecycle before emitting `session.faulted` and ending the stream.

#### Scenario: Pi identity becomes available

- **WHEN** first-Turn startup obtains a stable Pi Session ID and optional locator
- **THEN** the Session emits `session.state.changed` with a matching `NativeSessionRef`
- **AND** the state event precedes that Turn's lifecycle outputs

#### Scenario: Pi faults during an active Turn

- **WHEN** the Pi process exits or its protocol becomes unusable during an accepted Turn
- **THEN** the Item and Turn receive failed terminal outputs exactly once
- **AND** `session.faulted` follows the Turn terminal output
- **AND** the output stream ends

### Requirement: Session and Adapter close are bounded and idempotent

Session and Adapter close operations SHALL be idempotent, SHALL reject new commands after closing starts, SHALL release owned Pi processes within configured bounds, and SHALL NOT delete Native Session history.

#### Scenario: Session closes after successful Turns

- **WHEN** the Host closes an idle Pi Session more than once
- **THEN** the underlying Pi transport closes once
- **AND** all close calls complete with the same final result

#### Scenario: Adapter closes owned Sessions

- **WHEN** the Host closes the Pi Adapter
- **THEN** every Session opened by that Adapter is closed
- **AND** no owned Pi process remains

### Requirement: Host projection preserves the proven text behavior

The Host SHALL consume Harness outputs and project the existing Codex text Thread behavior while remaining transparent for Codex-owned requests.

#### Scenario: Pi Turn is projected

- **WHEN** a Pi Session emits a successful text lifecycle
- **THEN** the originating Codex Thread receives the corresponding Turn, Agent Message delta, Item completion, and Turn completion

#### Scenario: Same Thread status converges after sequential Turns

- **WHEN** two sequential Pi Turns complete in the same Harness Session
- **THEN** the Host publishes `thread/status/changed(active)` and `thread/status/changed(idle)` for each Turn
- **AND** each idle status follows the corresponding `turn/completed`
- **AND** `thread/read` reports the Thread as idle after the second Turn completes

#### Scenario: Command result and output race

- **WHEN** Adapter outputs are queued before `execute(turn.start)` resolves
- **THEN** the Host writes the Codex `turn/start` response before projecting that Turn's notifications

#### Scenario: Codex request is not owned by Pi

- **WHEN** a request belongs to the official Codex Harness
- **THEN** it continues through the stock app-server path without using the Pi Adapter

### Requirement: Native Session identity publication is fail-closed

A concrete Adapter SHALL publish a Native Session Ref only when the native Harness has provided or accepted a stable Session identity. An Adapter MUST NOT synthesize a fallback identity when required native state omits or invalidates that identity.

#### Scenario: Native protocol omits Session identity

- **WHEN** a Native Session state response lacks a non-blank stable Session identity
- **THEN** the Adapter SHALL return or emit a normalized protocol failure
- **AND** it SHALL NOT publish or persist a generated Native Session Ref

#### Scenario: Adapter assigns an identity accepted by the Harness

- **WHEN** an official Harness interface accepts a caller-assigned Session identity and uses it for persisted native history
- **THEN** the Adapter MAY publish that confirmed identity
- **AND** repeated Turn identities for that Session SHALL continue to reference the same Native Session identity

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
