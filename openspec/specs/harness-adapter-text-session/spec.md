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

- **WHEN** Pi emits text deltas and settles successfully for an accepted Turn
- **THEN** outputs contain `turn.started`, Agent Message `item.started`, ordered `text.append` updates, `item.completed`, and `turn.completed(succeeded)` in that order

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

#### Scenario: Command result and output race

- **WHEN** Adapter outputs are queued before `execute(turn.start)` resolves
- **THEN** the Host writes the Codex `turn/start` response before projecting that Turn's notifications

#### Scenario: Codex request is not owned by Pi

- **WHEN** a request belongs to the official Codex Harness
- **THEN** it continues through the stock app-server path without using the Pi Adapter
