## ADDED Requirements

### Requirement: Harness Sessions negotiate active-Turn steering explicitly

The public Harness Session contract SHALL expose an optional `activeTurns.steer` capability and a typed `turn.steer` command containing the existing Host Turn identity, ordered text input, and an optional client user-message identity. Omission or false SHALL mean unsupported. A successful command SHALL acknowledge admission to the same active Host Turn and SHALL NOT create another Host Turn lifecycle.

#### Scenario: A capable Session accepts steering

- **WHEN** `turn.steer` references the active text Turn with valid non-empty input
- **THEN** the Session SHALL admit the input to that Turn and return its existing Turn ID
- **AND** all later Item and terminal output SHALL continue to reference that same Host Turn

#### Scenario: Capability is absent

- **WHEN** steering targets a Session that does not advertise `activeTurns.steer=true`
- **THEN** Host or the Adapter SHALL return `unsupported` without sending native input
- **AND** the active lifecycle SHALL remain unchanged

#### Scenario: Native steering contract is not verified

- **WHEN** OpenCode reports a native version whose steering and Message-ID contract has not been independently verified
- **THEN** the Adapter SHALL omit `activeTurns.steer` and use the ordinary native root-prompt path without caller-generated grouping IDs

### Requirement: Host routes external steering without leaking external identity

Host SHALL resolve `turn/steer.threadId` before passthrough. It SHALL route an externally owned request only to that Thread's Harness Session, require `expectedTurnId` to equal the active Turn, accept text input only, and reject unsupported, malformed, stale, or failed requests locally. It MUST NOT forward an externally owned steering request to official Codex. Requests for official Codex Threads SHALL remain byte-equivalent protocol passthrough.

#### Scenario: External active Turn is steered

- **WHEN** Desktop sends valid `turn/steer` for a capable externally owned active Turn
- **THEN** Host SHALL execute one Harness `turn.steer` command and return `{ turnId }`
- **AND** any output caused synchronously by admission SHALL be emitted only after that response

#### Scenario: External steer is invalid or unsupported

- **WHEN** the expected Turn is stale, input is not text, capability is absent, or the Adapter rejects admission
- **THEN** Host SHALL return a local typed error without forwarding the frame to official Codex
- **AND** it SHALL not create a new Host Turn

#### Scenario: Official Codex Turn is steered

- **WHEN** the Thread is not owned by an external Harness
- **THEN** Host SHALL forward the original `turn/steer` request unchanged to the official app-server

### Requirement: Identified steering retries are exactly once

Host and every steering-capable Adapter SHALL key an active-Turn steering request by its optional client user-message identity. Repeating the same identity and identical input SHALL reuse the original admission result without writing another native user message. Reusing the identity with different input SHALL return `invalidRequest`.

#### Scenario: Desktop retries an accepted steering message

- **WHEN** two overlapping or sequential requests carry the same client identity and identical input
- **THEN** exactly one native steering message SHALL be admitted
- **AND** both requests SHALL observe the same successful Turn identity

#### Scenario: Client identity is reused for different input

- **WHEN** a later request carries an existing client identity with different input
- **THEN** Host or the Adapter SHALL reject it without a second native write

#### Scenario: An identified request is retried after cancellation starts

- **WHEN** cancellation starts after an identified steering request has entered admission and the identical request is retried
- **THEN** the Adapter SHALL return the original admission result rather than replacing it with cancellation state
- **AND** a conflicting retry with that identity SHALL remain `invalidRequest`

### Requirement: OpenCode steering converges with completion and cancellation

OpenCode SHALL serialize current-API prompt admissions for the active Turn, own each admitted native user-message identity, and defer Turn completion while any steering admission or newer lifecycle version exists. Successful completion SHALL require a terminal assistant for the latest admitted user message followed by native idle. A terminal Assistant while native state remains busy SHALL remain steerable because it may be an intermediate tool-call segment. A failed admission response SHALL be reconciled by its caller-generated native message identity before failure is reported. Cancellation SHALL synchronously reject later steering, allow an already-started admission to settle, reject queued admissions before transport, wait for every accepted user identity to become visible, and issue native abort at most once.

#### Scenario: Steering enters before terminal reconciliation commits

- **WHEN** OpenCode is reading transcript state, the latest terminal-plus-idle boundary has not yet been established, and a valid steering request enters
- **THEN** that reconciliation SHALL NOT publish `turn.completed`
- **AND** a later reconciliation SHALL use the latest admitted user message as the terminal boundary

#### Scenario: Steering arrives after the latest native terminal reaches idle

- **WHEN** the latest owned user has a terminal Assistant followed by idle and no admission or Interaction is pending
- **THEN** a new steering request SHALL fail with `invalidState` without another native prompt

#### Scenario: Cancellation races with multiple steering requests

- **WHEN** one steering admission is in flight, another is queued, and cancellation is requested
- **THEN** the in-flight admission MAY settle, the queued admission SHALL fail without native transport, and native abort SHALL run once after the admission chain
- **AND** the Host Turn SHALL still emit exactly one terminal outcome

#### Scenario: An admitted steering message is left idle without an Assistant

- **WHEN** the latest owned steering user message is persisted, native state reaches a stable idle boundary, no Assistant is parented by that message, and no Interaction is pending
- **THEN** the Adapter SHALL admit at most one namespaced recovery prompt while idle
- **AND** it SHALL either complete from the recovery Assistant or fail the same Host Turn without waiting indefinitely
- **AND** a newer steer, cancellation, fault, resumed busy state, answered orphan, or new Interaction before native admission SHALL suppress that recovery write

#### Scenario: Recovery preconditions are absent

- **WHEN** an unanswered native user is the root prompt or a steering admission failed without persistence
- **THEN** the Adapter SHALL NOT write a recovery prompt

#### Scenario: Admission response fails after persistence

- **WHEN** native prompt admission reports an error but the caller-generated user message identity is present in the authoritative transcript
- **THEN** the Adapter SHALL treat the admission as accepted and SHALL NOT write a duplicate user message

#### Scenario: Transport faults during steering admission

- **WHEN** the transport stream faults after a steering request entered native admission
- **THEN** the Adapter SHALL close later admission, wait for the entered request, retain its generated identity even if the prompt response and immediate transcript read fail, abort once, and perform bounded transcript reconciliation
- **AND** it SHALL publish one failed Turn with the root Native Turn identity before faulting and closing Session output

### Requirement: OpenCode history preserves one logical steered Turn

OpenCode SHALL project a root user message and its contiguous namespaced steering messages as one Host Turn. The snapshot SHALL retain ordered user input and all assistant Items, omit an internal namespaced recovery prompt only when it remains inside that intact root-led group, use the root user message as `NativeTurnRef`, use the last assistant terminal as outcome and Checkpoint, and retrieve reliable File Changes for every native user segment including recovery. Fork SHALL accept only a logical Turn's final Checkpoint, and last-Turn rollback SHALL remove the whole group from its root boundary.

#### Scenario: A resumed Turn contains steering segments

- **WHEN** persisted OpenCode history contains one root message followed by one or more valid steering messages in the same group
- **THEN** `readSnapshot()` SHALL return one Host Turn with all inputs and assistant Items in native order
- **AND** its Native Turn key SHALL be the root message and its Checkpoint SHALL be the final assistant message

#### Scenario: Fork targets an intermediate assistant segment

- **WHEN** a requested Checkpoint belongs to an earlier assistant segment of a steered logical Turn
- **THEN** OpenCode SHALL reject it as a non-Turn boundary

#### Scenario: Last-Turn rollback targets a steered Turn

- **WHEN** the final logical Turn contains multiple native steering messages
- **THEN** rollback SHALL derive history ending before the group's root user message
- **AND** no segment of that logical Turn SHALL remain as a separate Host Turn

#### Scenario: A recovery-shaped message is outside an intact group

- **WHEN** a recovery-shaped native user message is standalone or separated from its root by another user message
- **THEN** history SHALL project it as visible ordinary user input in its own Host Turn
