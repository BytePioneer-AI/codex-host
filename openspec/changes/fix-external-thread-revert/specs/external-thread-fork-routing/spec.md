## ADDED Requirements

### Requirement: External latest-message revert matches paginated Desktop semantics

For a paginated external Thread whose Adapter supports exact last-Turn rollback and whose current Session reports `history.replacementFence=true`, Host SHALL route a current Desktop `thread/revert` locally when `beforeTurnId` identifies the latest completed persisted Host Turn. Before success, Host SHALL commit a distinct replacement Native Session, preserve the retained Host Turn IDs, rebuild their Native refs from the replacement Snapshot, and verify a semantically equal retained history with matching Checkpoint presence. It SHALL return a `ThreadRevertResponse` containing a metadata-only Thread plus both required pagination cursors, emit exactly one `thread/reverted` notification after the response, and MUST NOT forward the request or transcript content to official Codex. This operation SHALL NOT mutate the source Native Session or revert project files.

#### Scenario: Latest message is edited with retained history

- **WHEN** Desktop reverts the latest completed Turn of a paginated external Thread with older retained Turns
- **THEN** the response Thread SHALL keep the same Host Thread ID and contain an empty `turns` array
- **AND** `turnsBackwardsCursor` and `itemsBackwardsCursor` SHALL be non-null cursors for the committed retained history
- **AND** Host SHALL emit `thread/reverted` only after that response
- **AND** the replacement `turn/start` SHALL execute through the replacement Native Session on the same Host Thread

#### Scenario: The only message is edited

- **WHEN** Desktop reverts the only completed Turn of a paginated external Thread
- **THEN** the response SHALL contain null `turnsBackwardsCursor` and null `itemsBackwardsCursor`
- **AND** the same Host Thread SHALL accept a replacement first Turn through the replacement Native Session

#### Scenario: Revert is outside the supported latest-message boundary

- **WHEN** `beforeTurnId` is unknown, is not the latest completed Turn, the Thread is active or legacy, the Adapter lacks exact last-Turn rollback, or the current Session lacks a history replacement fence
- **THEN** Host SHALL reject the request explicitly without changing Mapping Store, runtime Session, retained history, or project files
- **AND** it MUST NOT forward the request to official Codex

#### Scenario: Legacy Fork rollback lacks a replacement fence

- **WHEN** Desktop requests rollback of a legacy Fork-derived Thread whose Session can Fork but omits or disables `history.replacementFence`
- **THEN** Host SHALL reject before opening a rollback candidate
- **AND** it SHALL leave the Mapping Store record and loaded source Session unchanged

#### Scenario: Another Host route is accessing the source Session

- **WHEN** configuration, command catalog discovery, or exact Usage refresh Native work is still in flight on the authoritative Session
- **THEN** Host SHALL reject a racing history replacement before closing that Session
- **AND** the source Session and stored mapping SHALL remain authoritative until the access settles

#### Scenario: Codex-owned Thread is reverted

- **WHEN** `thread/revert.threadId` does not identify a mapped external Thread
- **THEN** Host SHALL forward the original request frame unchanged to official Codex
