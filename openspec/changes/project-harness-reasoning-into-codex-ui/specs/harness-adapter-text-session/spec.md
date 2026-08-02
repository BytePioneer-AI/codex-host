## MODIFIED Requirements

### Requirement: Accepted text Turns have an ordered complete lifecycle

A Session SHALL expose one single-consumer ordered output stream. Every accepted text Turn SHALL produce exactly one `turn.started` and one `turn.completed`, SHALL retain the established Agent Message lifecycle, MAY expose zero or more Reasoning Item lifecycles only for explicit visible native reasoning, and SHALL complete every started Item before the Turn terminal event.

#### Scenario: Successful text Turn with Reasoning

- **WHEN** Pi emits visible reasoning before text deltas and reaches `agent_settled`, and the subsequent native state readback confirms `isStreaming === false`
- **THEN** outputs contain `turn.started`, the corresponding Reasoning lifecycle, ordered Agent Message `text.append` updates, every Item terminal, and `turn.completed(succeeded)`
- **AND** each visible Reasoning and Agent Message character appears exactly once in native order

#### Scenario: Successful text Turn without Reasoning

- **WHEN** Pi emits text deltas but no visible reasoning and reaches `agent_settled`, and the subsequent native state readback confirms `isStreaming === false`
- **THEN** outputs contain `turn.started`, Agent Message `item.started`, ordered `text.append` updates, `item.completed`, and `turn.completed(succeeded)` in that order
- **AND** no Reasoning Item is manufactured

#### Scenario: Native settlement cannot be confirmed

- **WHEN** Pi emits `agent_settled` but native state remains Streaming, is malformed, or cannot be read back within the RPC Command bound
- **THEN** every started lifecycle SHALL complete exactly once with a failed outcome
- **AND** the Session SHALL emit `session.faulted`

#### Scenario: Accepted Turn fails

- **WHEN** Pi rejects or fails after the Turn has been accepted
- **THEN** every started Agent Message or Reasoning Item completes with a failed outcome
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
