## ADDED Requirements

### Requirement: Direct last-message rollback operates on the current External Thread
When the supported Desktop directly sends `thread/rollback { numTurns: 1 }` for the current ready External Thread, Host SHALL treat it as a current-Thread last-message rollback. The operation SHALL require the current Thread to be idle with at least one mapped Turn and its Session to report `history.rollbackLastTurn=true`. It SHALL NOT require `forkSource` or a source Checkpoint. Host SHALL derive the current history without its final Turn, keep the same Host Thread ID and retained Host Turn IDs, atomically replace Native refs, and leave project files unchanged. A zero-Turn result SHALL be valid. Existing `thread/fork` and post-Fork rollback behavior SHALL remain separate and unchanged.

#### Scenario: Desktop edits the last message of the current External Thread
- **WHEN** Desktop directly sends `thread/rollback { numTurns: 1 }` for an idle capable External Thread with two or more mapped Turns
- **THEN** Host SHALL return the same Host Thread with only its final Turn removed
- **AND** the replacement Session SHALL contain the exact retained prefix and accept the later edited `turn/start`

#### Scenario: Desktop edits the only message of the current External Thread
- **WHEN** Desktop directly sends `thread/rollback { numTurns: 1 }` for an idle capable External Thread containing exactly one mapped Turn
- **THEN** Host SHALL atomically rebind the same Host Thread to a Session with zero Turns
- **AND** the rollback response SHALL contain an empty `turns` array

#### Scenario: Current External Thread cannot roll back its last message
- **WHEN** direct last-message rollback references an active or empty External Thread, requests `numTurns` other than one, lacks the required Adapter capability, or cannot produce an exact Session
- **THEN** Host SHALL reject the request explicitly without changing Store, runtime, Native Session history, or project files
- **AND** it SHALL NOT forward the request to Codex

#### Scenario: Codex-owned Thread rollback is requested
- **WHEN** `thread/rollback.threadId` does not identify a mapped External Thread
- **THEN** the original request frame SHALL be forwarded unchanged to the official app-server

### Requirement: Last-message edit reuses the native Desktop interaction
The External last-message edit feature SHALL consume Codex Desktop's existing pencil action and its direct `thread/rollback { numTurns: 1 }` followed by edited `turn/start` sequence. Renderer Extension MUST NOT add another edit control, restore message content, intercept rollback, or automatically resend the message.

#### Scenario: User edits the latest editable text message in a Pi Thread
- **WHEN** the supported Desktop invokes its native pencil action for the latest editable text User Message of a capable Pi Thread
- **THEN** Host SHALL realize the rollback against that current Thread through the owning Adapter and return the expected `ThreadRollbackResponse`
- **AND** the unmodified Desktop interaction SHALL submit the user's edited text through the normal later `turn/start`
