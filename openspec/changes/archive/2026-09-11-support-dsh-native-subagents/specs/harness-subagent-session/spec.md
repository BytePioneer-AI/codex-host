## MODIFIED Requirements

### Requirement: Subagents expose stable read-only Child Host Threads
When a supporting Harness provides a stable native Subagent identity and transcript history, Host Runtime SHALL register a stable Child Host Thread, persist only its Parent/Child identity mapping, and use the Child Host Thread ID as the collaboration receiver. Child transcript content SHALL remain owned by the Harness. Opening or restoring Child Threads SHALL preserve observed running state, and root-owned Subagent observations SHALL remain scoped to the current Harness, Native Session, and Parent tree.

#### Scenario: User opens Subagent detail

- **WHEN** Codex Desktop requests a receiver Child Thread from a projected Subagent delegation
- **THEN** Host Runtime SHALL return metadata with the correct Parent Thread relationship and read-only input capability
- **AND** paginated Turn and Item history SHALL be reconstructed from the Adapter's Subagent transcript operation
- **AND** supported intermediate Assistant, Reasoning, Command, Tool, and Tool Result evidence SHALL remain visible in full Child history while remaining hidden from the Parent Thread
- **AND** when the Harness reports that a running Subagent transcript changed, Host Runtime SHALL announce the stable Child Turn as active before publishing newly available Items so an already-open Child Thread receives them without requiring close and reopen
- **AND** a later partial or temporarily empty transcript read SHALL NOT remove previously observed Child Turns, User input, or Items
- **AND** metadata reads, Child restoration, and detail opening SHALL preserve the latest observed Child running state rather than reset it to idle

#### Scenario: Child Agent work starts and finishes

- **WHEN** a native Subagent starts or resumes work
- **THEN** the delegation SHALL immediately report that Subagent as running rather than waiting for stable Child identity or native completion
- **AND** Host Runtime SHALL publish a materialized Child Host Thread as active
- **AND** subsequent Subagent state replacements SHALL be projected to the native collaboration Item while it remains active
- **AND** while one or more background Subagents remain running, Host Runtime SHALL keep the Parent Host Thread active; the Adapter SHALL preserve the Harness-native Turn boundary, either holding a correlated Turn or publishing Session-scoped child updates after that Turn completes
- **AND** when the Harness reports that a native Subagent completed, failed, or was interrupted, Host Runtime SHALL refresh its terminal Child transcript and publish the Child Host Thread as idle
- **AND** after the last running background Subagent settles, no Root continuation is executing, and no Root Turn is active, Host Runtime SHALL publish the Parent Host Thread as idle

#### Scenario: Host restarts before Child detail is opened

- **WHEN** a persisted Child Host Thread is opened after Host restart
- **THEN** Host Runtime SHALL recover the native Subagent identity from Mapping Store and reread current Harness history
- **AND** Mapping Store SHALL contain no Subagent transcript text

#### Scenario: Parent history restores current Child states

- **WHEN** a restored or refreshed Parent Snapshot materializes Child Threads before live state observations arrive
- **THEN** Host Runtime SHALL initialize their unobserved running states from the latest delegated states in that Snapshot
- **AND** historical states SHALL NOT overwrite already observed live states
- **AND** newer snapshots MAY update snapshot-initialized states until a live observation supersedes them
- **AND** transient collaboration receiver identifiers without a persisted Child mapping SHALL NOT create phantom running Threads

#### Scenario: Read-only descendant is opened without a live Root Session

- **WHEN** a running read-only Child Thread is read or resumed before its Root Session has a live output subscription
- **THEN** Host Runtime SHALL refresh requested head history from the Adapter even when the Child currently displays active
- **AND** later parent snapshots SHALL update snapshot-initialized descendant state without replacing live observations

#### Scenario: Root observes nested Subagent progress

- **WHEN** a Root Session reports a state or transcript change for a materialized descendant with an unambiguous Adapter-scoped native identity
- **THEN** Host Runtime SHALL route the observation through persisted Parent relationships to that descendant
- **AND** an already-open descendant detail SHALL receive refreshed progress and terminal history without reopening
- **AND** same-named descendants under another Parent tree or Harness, descendants left in a replaced Native Session, missing ancestry, cycles, and ambiguous identities SHALL NOT receive the observation
