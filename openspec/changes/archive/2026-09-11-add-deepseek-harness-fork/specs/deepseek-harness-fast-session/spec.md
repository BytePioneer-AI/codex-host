## MODIFIED Requirements

### Requirement: DeepSeek Harness uses the shared Adapter contract

The system SHALL provide a `deepseek-harness` implementation of `HarnessAdapter` and `HarnessSession`. DSH JSON-RPC methods, event names, Checkpoint encoding, and Fork validation details MUST remain internal to that Adapter package.

#### Scenario: New DeepSeek Session opens

- **WHEN** Host opens the DeepSeek Adapter with a create input and an available runtime
- **THEN** the Adapter SHALL return a HarnessSession with a stable Native Session reference
- **AND** `open(create)` and `open(resume)` SHALL be available
- **AND** Modern inspection and Session capabilities SHALL report `history.fork=true`, `history.forkAcrossCwd=false`, and `history.rollbackLastTurn=true`
- **AND** Legacy inspection and Session capabilities SHALL keep `history.rollbackLastTurn=false`

#### Scenario: Existing DeepSeek Session resumes

- **WHEN** Host opens the Adapter with a valid mapped DeepSeek Native Session reference
- **THEN** the Adapter SHALL resume that exact Session and expose an immediate full Snapshot
- **AND** it SHALL NOT create a replacement Session or change native configuration

### Requirement: Unsupported fast-path capabilities are explicit

The DeepSeek Adapter SHALL reject cross-cwd Fork as unsupported and SHALL NOT publish the optional Subagent capability. The Legacy Adapter SHALL continue to reject rollback. Each generation SHALL publish and execute only the capabilities verified for its connected DSH Host.

#### Scenario: Host attempts cross-cwd Fork

- **WHEN** Host requests a DeepSeek Fork whose normalized target cwd differs from the source Session cwd
- **THEN** the Adapter SHALL return an `unsupported` error before invoking `sessions.fork`
- **AND** it SHALL NOT create a replacement Session or modify project files

#### Scenario: Host attempts Legacy rollback

- **WHEN** Host opens the Legacy Adapter with a rollback input
- **THEN** the Adapter SHALL return an `unsupported` error without mutating the source Session

## ADDED Requirements

### Requirement: DeepSeek Model and Thinking state comes from structured native readback

The DeepSeek Adapter SHALL derive selectable Model and Thinking options from validated DSH model catalogs and SHALL publish effective state only after `sessions.models()` confirms the current Session selection. It MUST NOT guess an effort ID or preserve a requested value that native readback does not confirm.

#### Scenario: Model selection omits Thinking

- **WHEN** an idle DeepSeek Session selects another Model without a reasoning effort
- **THEN** the Adapter SHALL let DSH apply that Model's default effort
- **AND** it SHALL publish the Model and effective Thinking only from the subsequent native readback

#### Scenario: Fork restores historical configuration

- **WHEN** DSH creates a child from a Checkpoint whose seed contains an earlier Model or Thinking selection
- **THEN** the Adapter SHALL initialize the child from that child Session's `sessions.models()` response
- **AND** it SHALL NOT overwrite the child with the source page's current configuration

### Requirement: DeepSeek Harness Commands use the native command registry

The DeepSeek Adapter SHALL list only explicitly registered and natively advertised Harness Commands. Executing `dsh.compact` SHALL invoke DSH's native command service and project a temporary Host Turn without inserting that command Turn into ordinary Session history.

#### Scenario: Registered compact command executes

- **WHEN** DSH advertises an argument-free `compact` command and Host executes `dsh.compact`
- **THEN** the Adapter SHALL invoke the native `/compact` command seam
- **AND** it SHALL project the command lifecycle without appending a normal text Turn to the DSH conversation

#### Scenario: Command is unknown or has arguments

- **WHEN** Host supplies an unregistered command ID or arguments to `dsh.compact`
- **THEN** the Adapter SHALL reject the request before invoking the native command service

### Requirement: DeepSeek same-cwd Fork is exact and fail-closed

Every Fork-capable DeepSeek Turn SHALL expose a stable Checkpoint derived from its native `turn/end` event seq. `open(fork)` SHALL validate that exact source boundary, invoke `sessions.fork` with the explicit terminal seq, and return a distinct child only after its raw inherited event prefix, projected Turn count, terminal Checkpoint, Native Ref ownership, and native Model/Thinking readback are consistent. It MUST NOT retry an ambiguous native Fork result.

#### Scenario: Middle completed Turn is Forked while source has a later active Turn

- **WHEN** Host Forks a valid completed-turn Checkpoint and the source has later completed or active events
- **THEN** the child SHALL contain the selected Turn and its ancestors plus native log-only events before the next `turn/start`
- **AND** it SHALL contain no later source Turn
- **AND** the source and child SHALL continue independently

#### Scenario: Native workspace attachment partially fails

- **WHEN** DSH returns `workspace-attach-failed` with the already-created child Session ID
- **THEN** the Adapter SHALL apply the complete child verification to that Session
- **AND** it SHALL adopt the child only if every exact-Fork invariant passes

#### Scenario: Derived history cannot be proven exact

- **WHEN** the child ID equals the source, the raw seed differs, a later `turn/start` leaks into the child, Turn counts differ, or Native Refs do not belong to the child
- **THEN** the Adapter SHALL fail with a non-retryable protocol error and release its child subscription
- **AND** it SHALL NOT register the child as a Host Thread

#### Scenario: Source Checkpoint is invalid

- **WHEN** source/checkpoint identities are foreign or mismatched, the Checkpoint encoding is invalid, or it does not identify a real source `turn/end`
- **THEN** the Adapter SHALL return `invalidRequest` or `checkpointNotFound` as appropriate
- **AND** it SHALL NOT invoke native Fork

### Requirement: DeepSeek Modern Last-Turn Rollback creates an exact replacement

The exact `dsh-v0.1.2-rc.1` Modern Adapter SHALL implement `open(rollbackLastTurn)` by returning a distinct Native Session whose complete history is the source's exact current completed history without its final Turn. It SHALL leave the source Session and project files unchanged. Model, Thinking, Permission and mapping replacement SHALL remain owned by the existing Host rollback transaction.

#### Scenario: A multi-Turn Session rolls back

- **WHEN** the source contains at least two completed Turns and no incomplete Turn
- **THEN** the Adapter SHALL Fork at the penultimate Turn's exact `turn/end` Checkpoint
- **AND** the existing child identity, raw prefix, cwd, seed and projected-history verification SHALL apply

#### Scenario: A single-Turn Session rolls back

- **WHEN** the source contains exactly one completed Turn and no incomplete Turn
- **THEN** the Adapter SHALL create a distinct empty Session
- **AND** it SHALL pass the source journal's current projected Agent Preset to `session/create` and verify the returned Session preserves it

#### Scenario: The source is empty or active

- **WHEN** the source contains no completed Turn or contains an incomplete Turn
- **THEN** the Adapter SHALL return `invalidState` or `sessionBusy` respectively
- **AND** it SHALL NOT invoke `session/create` or `session/fork`
