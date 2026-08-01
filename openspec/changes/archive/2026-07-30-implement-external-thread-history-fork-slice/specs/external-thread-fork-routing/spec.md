## ADDED Requirements

### Requirement: Codex thread/fork is routed by source ownership
Protocol Facade SHALL handle `thread/fork` according to the source Host Thread owner. Official Codex sources SHALL remain transparent; mapped external sources SHALL be handled locally through their registered HarnessAdapter and MUST NOT be forwarded to Codex.

#### Scenario: Codex source is Forked
- **WHEN** `thread/fork.threadId` does not identify a mapped external Thread
- **THEN** the original request frame SHALL be forwarded unchanged to the official app-server

#### Scenario: External source is Forked
- **WHEN** `thread/fork.threadId` identifies a mapped external Thread
- **THEN** Host SHALL resolve and execute the Fork through that Thread's HarnessAdapter
- **AND** the official app-server SHALL receive neither the Fork nor source content

### Requirement: Current Codex Fork boundaries resolve exactly
For an external source, Host SHALL support inclusive `lastTurnId`, exclusive `beforeTurnId`, and omitted tail boundaries using persisted ordered Turn mappings. Both boundary fields, an unknown Turn, a first-Turn exclusive boundary, or a Turn without a real Checkpoint SHALL be rejected explicitly.

#### Scenario: Inclusive boundary is requested
- **WHEN** `lastTurnId` references a completed mapped Turn with a Checkpoint
- **THEN** the derived history SHALL include that Turn and exclude every later source Turn

#### Scenario: Exclusive boundary is requested
- **WHEN** `beforeTurnId` references a non-first mapped Turn
- **THEN** Host SHALL Fork through the immediately preceding mapped Turn and exclude the referenced Turn and every later Turn

#### Scenario: Tail Fork is requested
- **WHEN** neither boundary is present
- **THEN** Host SHALL use the latest completed mapped Turn's Checkpoint

### Requirement: Supported Desktop post-Fork rollback resolves exactly
When the supported Desktop sends an unbounded `thread/fork` followed by `thread/rollback` for the resulting mapped external Thread, Host SHALL interpret `numTurns` against the derived Thread's ordered persisted Turn mappings. Host SHALL support this composition only while the derived history is still exactly the source prefix through its persisted `forkSource` boundary. It SHALL create a final distinct Native Session from the retained source Checkpoint, keep the derived Host Thread ID and retained derived Host Turn IDs, atomically replace their Native refs and Fork source boundary, and leave the source Thread unchanged.

#### Scenario: Earlier message action rolls back a tail Fork
- **WHEN** a three-Turn external source was tail-Forked and Desktop requests `thread/rollback { numTurns: 2 }` for that untouched derived Thread
- **THEN** the same derived Host Thread SHALL be rebound to a distinct Native Session containing exactly the first Turn
- **AND** its `forkSource.hostTurnId` SHALL identify the source first Turn
- **AND** the temporary tail-Fork Session SHALL be closed without changing the source Session

#### Scenario: Retained derived Turn identity stays stable
- **WHEN** post-Fork rollback retains a prefix of an already returned derived Thread
- **THEN** each retained Host Turn ID SHALL remain unchanged
- **AND** each retained Native Turn and Checkpoint Ref SHALL be rebuilt from the final Native Session Snapshot

#### Scenario: Rollback target is not an untouched derived prefix
- **WHEN** `thread/rollback` references an original external Thread, a derived Thread that independently continued, all existing Turns, an unknown source boundary, or a Turn without a real Checkpoint
- **THEN** Host SHALL reject the request explicitly without changing Store, runtime, source, or project files
- **AND** it SHALL NOT forward the request to Codex

#### Scenario: Codex-owned Thread rollback is requested
- **WHEN** `thread/rollback.threadId` does not identify a mapped external Thread
- **THEN** the original request frame SHALL be forwarded unchanged to the official app-server

### Requirement: External Fork parameters fail closed
External Fork SHALL reject a non-empty source path, mismatched cwd, an incompatible Harness transport carrier, an active source Turn, unsupported Adapter capability, missing NativeSessionRef, or malformed boundary without creating an official shadow Thread.

#### Scenario: Source Turn is active
- **WHEN** Desktop requests Fork while the external source has an active Turn
- **THEN** Host SHALL return a busy error and leave source and Store unchanged

#### Scenario: Request carries another Harness
- **WHEN** an external Pi source Fork carries a Codex or Claude transport Model override
- **THEN** Host SHALL reject the request rather than change Harness or forward it

### Requirement: Derived Thread is rebuilt from derived native history
After native Fork, Host SHALL read the derived Native Session Snapshot, allocate or persist Host Turn IDs against derived NativeTurnRefs, and project a new Codex Thread. It MUST NOT copy source Host Turn mappings or a persisted Host Transcript.

#### Scenario: Native IDs are remapped by Fork
- **WHEN** the derived Harness assigns new native message or Turn IDs
- **THEN** Host SHALL create derived mappings from the derived Snapshot and SHALL NOT reuse source Host Turn IDs

#### Scenario: Fork response includes history
- **WHEN** `excludeTurns` is absent or false
- **THEN** `ThreadForkResponse.thread.turns` SHALL contain the projected derived Snapshot through the selected boundary

#### Scenario: Fork response excludes history
- **WHEN** `excludeTurns=true`
- **THEN** the response MAY omit Turn values but Host SHALL still commit the complete derived identity mappings before success

### Requirement: Fork and rollback responses match current Desktop Thread semantics
A successful external Fork SHALL return a new Host Thread ID, source `forkedFromId`, null subagent parent, required cwd and timeline metadata, source Harness transport carrier, and actual derived effective Model. A successful post-Fork rollback SHALL return the updated full Thread under the current `ThreadRollbackResponse` shape using the same derived Host Thread ID. The source Thread and its Native Session SHALL remain unchanged.

#### Scenario: Pi Fork succeeds
- **WHEN** Pi creates a distinct derived Native Session
- **THEN** Desktop SHALL receive a distinct Pi-owned Thread that can accept a later Turn
- **AND** source continuation SHALL still target the original Pi Native Session

### Requirement: Known persisted external Threads resume on demand
`thread/read`, `thread/resume`, and `thread/fork` SHALL recognize a persisted external Thread even when it is not loaded in the current Host process, open its exact Native Session through resume or Fork, and never fall through to Codex.

#### Scenario: Host restarts before Fork
- **WHEN** Desktop references a persisted external Thread after Host restart
- **THEN** Host SHALL recover ownership and Native identity, read current Native history, and allow exact Fork from a persisted Anchor

#### Scenario: Persisted native Session is missing
- **WHEN** the mapped Native Session cannot be opened
- **THEN** Host SHALL return an explicit session error and SHALL NOT create or query a Codex Thread with the same ID
