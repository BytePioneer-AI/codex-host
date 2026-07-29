## ADDED Requirements

### Requirement: Claude Code implements the existing HarnessAdapter contract
The system SHALL provide a concrete Claude Code Adapter that exposes only the existing UI-independent create, text Turn, cancel, fault, and close semantics. Claude SDK objects, message types, settings, process handles, and native protocol fields MUST remain inside the Adapter package.

#### Scenario: Host opens a Claude create Session
- **WHEN** a caller opens a create-mode Session with a valid cwd
- **THEN** the Adapter SHALL return a HarnessSession with Harness ID `claude-code`
- **AND** it SHALL NOT start Claude Code or create an empty Native Session

#### Scenario: Ordinary tests run
- **WHEN** repository formatting, lint, typecheck, build, or normal tests run
- **THEN** Fake Transport tests SHALL exercise the Adapter contract
- **AND** no test SHALL launch Claude Code, read user authentication, create Native Sessions, or consume model quota

### Requirement: Claude startup is lazy and Native identity is confirmed
The first accepted text Turn SHALL resolve the user-installed Claude Code executable, initialize one long-lived Agent SDK Query, and publish one Native Session Ref before that Turn lifecycle. Later sequential Turns SHALL reuse the same Query and Native Session.

#### Scenario: Unused Claude Session closes
- **WHEN** a Claude HarnessSession closes without a Turn
- **THEN** no Claude process or Native Session SHALL be created

#### Scenario: Claude is not installed
- **WHEN** the first Turn cannot resolve an executable user installation
- **THEN** the command SHALL fail before acceptance with `notInstalled`
- **AND** no Turn or Item lifecycle SHALL be emitted

#### Scenario: Two sequential Turns run
- **WHEN** one Session accepts and completes two text Turns
- **THEN** one SDK Query and one Native Session SHALL serve both Turns
- **AND** each caller-assigned User UUID SHALL be submitted once

### Requirement: Claude text streaming has one complete ordered lifecycle
Every accepted Claude text Turn SHALL emit one Turn start, one Agent Message start, ordered non-duplicated text append updates, one Item terminal, and one Turn terminal. Unknown native message types and non-text content MUST NOT cross the HarnessAdapter seam.

#### Scenario: Partial text and full Assistant agree
- **WHEN** SDK partial events stream a text prefix and the complete Assistant message contains that prefix plus a suffix
- **THEN** the Adapter SHALL append each character exactly once
- **AND** it SHALL append only the missing suffix from the complete message

#### Scenario: Streaming is unavailable
- **WHEN** no partial text event is emitted but a complete Assistant text message arrives
- **THEN** the Adapter SHALL publish that complete text once before the Item terminal

#### Scenario: Native text conflicts
- **WHEN** a complete Assistant text cannot be reconciled with text already emitted for the Turn
- **THEN** the Item and Turn SHALL fail exactly once
- **AND** the Adapter SHALL NOT replay or replace the visible text silently

### Requirement: Claude Result classification uses complete native evidence
A Claude Turn SHALL succeed only when the complete Result and Assistant evidence prove completion. The Adapter MUST inspect `subtype`, `is_error`, `terminal_reason`, Assistant error, and local cancel state rather than trusting one discriminant.

#### Scenario: Nominal success contains native error evidence
- **WHEN** a Result has `subtype=success` but `is_error=true`, a non-completed terminal reason, or an Assistant error
- **THEN** the Adapter SHALL complete the Turn as failed
- **AND** it SHALL map authentication evidence to `authenticationRequired` where applicable

#### Scenario: Successful Result completes
- **WHEN** the Result is non-error, completed, and has no Assistant error
- **THEN** the Agent Message and Turn SHALL complete succeeded exactly once

### Requirement: Claude cancellation waits for authoritative Result
A successful `turn.cancel` SHALL call SDK Interrupt but SHALL not terminate the Host Turn until native Result evidence arrives. Repeated cancel requests SHALL be idempotent, and the same Session SHALL remain reusable after proven cancellation.

#### Scenario: Streaming Turn is cancelled
- **WHEN** Interrupt is accepted for the active Turn and native Result ends with `aborted_streaming` or `aborted_tools`
- **THEN** every started Item SHALL complete cancelled before one `turn.completed(cancelled)`

#### Scenario: Abort cannot be proven
- **WHEN** Interrupt rejects, times out, the process exits, or Result does not carry a proven aborted terminal
- **THEN** the Turn SHALL fail rather than report cancelled

#### Scenario: Turn follows cancellation
- **WHEN** a cancelled Turn reaches its terminal event and the Query remains healthy
- **THEN** the same Session SHALL accept and complete a later text Turn

### Requirement: Claude close and faults are bounded and private
Session and Adapter close SHALL be idempotent, reject new commands after closing begins, terminate owned direct Claude processes within configured bounds, and preserve Native Session history. Unrecoverable Query or process faults SHALL finalize active lifecycles before `session.faulted` and stream end.

#### Scenario: Adapter closes multiple Sessions
- **WHEN** Adapter close is called more than once
- **THEN** every opened Session SHALL close once
- **AND** all calls SHALL converge on the same bounded result

#### Scenario: Query faults during an accepted Turn
- **WHEN** the SDK iterator or owned Claude process fails before an authoritative Result
- **THEN** the Item and Turn SHALL fail exactly once before `session.faulted`
- **AND** raw SDK errors, Prompt text, credentials, and native frames SHALL not enter Host outputs
