## MODIFIED Requirements

### Requirement: Supported Desktop post-Fork rollback resolves exactly
When the supported Desktop sends an unbounded `thread/fork` followed by `thread/rollback` for the resulting mapped external Thread, Host SHALL interpret `numTurns` against the derived Thread's ordered persisted Turn mappings. Host SHALL support this composition only while the derived history is still exactly the source prefix through its persisted `forkSource` boundary. It SHALL create a final distinct Native Session from the retained source Checkpoint, keep the derived Host Thread ID and retained derived Host Turn IDs, atomically replace their Native refs and Fork source boundary, and leave the source Thread unchanged.

When that post-Fork composition is not applicable, Host SHALL accept `thread/rollback` for a ready External Thread only when `numTurns=1`, the Thread is idle with at least one mapped Turn, and its Session reports `history.rollbackLastTurn=true`. Host SHALL derive a distinct Native Session containing the exact current history without its final Turn, keep the same Host Thread ID and retained Host Turn IDs, atomically replace the Native refs, and leave project files unchanged. A zero-Turn result SHALL be valid. This fallback MUST NOT implement arbitrary or multi-Turn Rewind.

#### Scenario: Earlier message action rolls back a tail Fork
- **WHEN** a three-Turn external source was tail-Forked and Desktop requests `thread/rollback { numTurns: 2 }` for that untouched derived Thread
- **THEN** the same derived Host Thread SHALL be rebound to a distinct Native Session containing exactly the first Turn
- **AND** its `forkSource.hostTurnId` SHALL identify the source first Turn
- **AND** the temporary tail-Fork Session SHALL be closed without changing the source Session

#### Scenario: Retained derived Turn identity stays stable
- **WHEN** post-Fork rollback retains a prefix of an already returned derived Thread
- **THEN** each retained Host Turn ID SHALL remain unchanged
- **AND** each retained Native Turn and Checkpoint Ref SHALL be rebuilt from the final Native Session Snapshot

#### Scenario: Desktop edits the last message of an External Thread
- **WHEN** Desktop sends `thread/rollback { numTurns: 1 }` for an idle capable External Thread with two or more mapped Turns and the post-Fork composition is not applicable
- **THEN** Host SHALL return the same Host Thread with only its final Turn removed
- **AND** the replacement Native Session SHALL contain the exact retained prefix and accept the later edited `turn/start`

#### Scenario: Desktop edits the only message
- **WHEN** Desktop sends `thread/rollback { numTurns: 1 }` for an idle capable External Thread containing exactly one mapped Turn
- **THEN** Host SHALL atomically rebind the same Host Thread to a distinct Native Session with zero Turns
- **AND** the rollback response SHALL contain an empty `turns` array

#### Scenario: External rollback is outside the supported shapes
- **WHEN** rollback references an active or empty External Thread, requests `numTurns` other than one outside an eligible post-Fork composition, lacks the required Adapter capability, or cannot produce an exact distinct Session
- **THEN** Host SHALL reject the request explicitly without changing Store, runtime, source Native Session, or project files
- **AND** it SHALL NOT forward the request to Codex

#### Scenario: Codex-owned Thread rollback is requested
- **WHEN** `thread/rollback.threadId` does not identify a mapped external Thread
- **THEN** the original request frame SHALL be forwarded unchanged to the official app-server

## ADDED Requirements

### Requirement: Last-message edit reuses the native Desktop interaction
The External last-message edit feature SHALL consume Codex Desktop's existing pencil action and its `thread/rollback { numTurns: 1 }` followed by edited `turn/start` sequence. Renderer Extension MUST NOT add another edit control, restore message content, intercept rollback, or automatically resend the message.

#### Scenario: User edits the latest Pi message
- **WHEN** the supported Desktop invokes its native pencil action for the latest User Message of a capable Pi Thread
- **THEN** Host SHALL realize the rollback through the owning Adapter and return the expected `ThreadRollbackResponse`
- **AND** the unmodified Desktop interaction SHALL submit the user's edited text through the normal later `turn/start`
