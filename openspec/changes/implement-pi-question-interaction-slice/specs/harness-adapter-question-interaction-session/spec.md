## ADDED Requirements

### Requirement: Harness Session exposes UI-independent Question interactions

A `HarnessSession` SHALL expose blocking Questions through its single ordered output stream and SHALL accept typed `interaction.respond` commands without exposing Pi RPC records, native callback IDs, Codex app-server payloads, or another Harness protocol.

#### Scenario: Adapter emits a choice Question

- **WHEN** the active native Turn requests a structured choice from the user
- **THEN** the Session SHALL emit a `question` Interaction with a Host Interaction ID, owning Host Turn ID, stable Question IDs, and typed options
- **AND** no native request identifier or protocol payload SHALL appear in the public value

#### Scenario: Adapter emits a text Question

- **WHEN** the active native Turn requests single-line, multiline, or secret text
- **THEN** the Session SHALL emit a typed text Question preserving the supported multiline, secret, placeholder, prefill, optional, and expiry semantics
- **AND** unsupported presentation details SHALL be omitted or explicitly degraded rather than encoded as native payload

### Requirement: Question output and closure obey the Turn lifecycle

Every exposed Question SHALL belong to one active Turn, SHALL appear after that Turn's `turn.started`, and SHALL close exactly once before the Turn's unique terminal event. The Session SHALL reject a new foreground Turn while any Question from the current Turn remains pending.

#### Scenario: Question is answered

- **WHEN** the Host submits one valid response for a pending Question and the Adapter accepts the matching native response
- **THEN** the response command SHALL return accepted
- **AND** the output stream SHALL emit exactly one `interaction.closed(responded)` before later Item or Turn terminal output

#### Scenario: Native Question expires

- **WHEN** the native dialog reaches its timeout without a valid Host response
- **THEN** the output stream SHALL emit exactly one `interaction.closed(expired)`
- **AND** a later response for that Interaction SHALL be rejected without affecting the Turn or another Interaction

#### Scenario: Turn reaches terminal processing

- **WHEN** native execution settles while one or more Questions are still pending
- **THEN** the Adapter SHALL close every pending Question with an evidence-based terminal reason before `turn.completed`
- **AND** the Turn SHALL still have exactly one terminal event

### Requirement: Question responses are exact, validated, and idempotent

The Session SHALL accept responses only for a pending Interaction owned by that Session and active Turn. It SHALL validate Question IDs, answer cardinality, option values, required fields, response type, and cancellation before writing a native response.

#### Scenario: Choice answer is accepted

- **WHEN** the Host responds to a required single-choice Question with one declared option value
- **THEN** the Adapter SHALL route that value only to the native callback associated with the Host Interaction ID
- **AND** the command result SHALL not imply that the Turn has completed

#### Scenario: User cancels a Question

- **WHEN** the Host explicitly cancels a pending Question
- **THEN** the Adapter SHALL send the native cancellation form for that same callback
- **AND** the Interaction SHALL close as cancelled or responded according to the native accepted semantics without becoming an Approval decision

#### Scenario: Invalid or duplicate response arrives

- **WHEN** a response references an unknown, already closed, wrong-Session, wrong-type, or malformed Question answer
- **THEN** the Session SHALL return `invalidRequest` or `invalidState`
- **AND** it SHALL NOT write any native response or alter another pending Interaction

### Requirement: Cancel, fault, and close converge pending Questions

Turn cancellation, Session close, native timeout, and transport fault SHALL leave no exposed Question pending. Cancel acceptance alone SHALL NOT fabricate a Turn terminal; the Adapter SHALL wait for native settlement or apply its existing bounded failure rules.

#### Scenario: Turn is cancelled while Question is pending

- **WHEN** the Host accepts `turn.cancel` during a blocking Question
- **THEN** the Adapter SHALL request native abort and close the pending Question before the Turn terminal
- **AND** the same Session SHALL accept a later Turn after cancellation has settled

#### Scenario: Session closes while Question is pending

- **WHEN** Session close begins during a blocking Question
- **THEN** the Question, active Items, and Turn SHALL each receive one ordered terminal outcome within the configured bound
- **AND** no native callback, timer, or owned process SHALL remain

#### Scenario: Transport faults while Question is pending

- **WHEN** the native process exits or the Interaction protocol becomes unusable
- **THEN** the Adapter SHALL close the Question, fail the active Turn, emit `session.faulted`, and end the output stream in that order

### Requirement: Codex projection uses the native user-input server request

Protocol Core and Host Runtime SHALL project a pending Host Question as the current Codex app-server `item/tool/requestUserInput` server request and SHALL validate the Desktop response before executing `interaction.respond`. Official Codex server requests and non-owned responses SHALL remain transparent.

#### Scenario: Tool-associated Question is projected

- **WHEN** a Host Question references an active Tool Item
- **THEN** the Codex request SHALL contain the owning external Thread ID, Turn ID, Tool Item ID, projected questions, and supported auto-resolution duration
- **AND** the Host SHALL correlate the response through a Host-owned JSON-RPC request ID without exposing native IDs

#### Scenario: Standalone Question is projected

- **WHEN** a Host Question has no native Tool Item
- **THEN** the Host SHALL establish the reviewed Codex-compatible synthetic Generic Tool Item lifecycle before sending `item/tool/requestUserInput`
- **AND** it SHALL complete that Item when the Interaction closes

#### Scenario: Desktop answer is malformed

- **WHEN** Desktop returns missing answers, undeclared options, invalid cardinality, or an error for a Host-owned request
- **THEN** the Host SHALL NOT forward the frame to the official app-server or submit malformed data to the Adapter
- **AND** the owning Interaction and Turn SHALL converge through an explicit cancel or failure path

#### Scenario: Response is not Host-owned

- **WHEN** Desktop sends a response whose ID is not in the Host Interaction registry
- **THEN** the Host SHALL forward the original frame unchanged to the official app-server

### Requirement: Question data remains private and ephemeral

Question prompts and answers SHALL remain in the live Interaction path and native Harness history only where the Harness itself records them. codexhost SHALL NOT write complete prompts, answers, secret values, or native callback IDs to diagnostics, route observations, Mapping Store, committed Fixtures, or ordinary test output.

#### Scenario: Current Desktop cannot safely render a secret Question

- **WHEN** a secret text Question reaches a projector whose reviewed native input control does not mask the value
- **THEN** the Host SHALL cancel the Interaction before sending that unsafe Desktop request
- **AND** tracked evidence SHALL contain only reviewed structural facts such as counts, booleans, and terminal reasons

#### Scenario: Interaction is not persisted

- **WHEN** a Question closes or its Turn completes
- **THEN** Host in-memory Interaction correlation SHALL be removed
- **AND** no normalized Interaction Transcript SHALL be written
