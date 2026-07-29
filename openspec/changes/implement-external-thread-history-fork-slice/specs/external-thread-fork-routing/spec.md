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

### Requirement: Fork response matches current Desktop Thread semantics
A successful external Fork SHALL return a new Host Thread ID, source `forkedFromId`, null subagent parent, required cwd and timeline metadata, source Harness transport carrier, and actual derived effective Model. The source Thread and its Native Session SHALL remain unchanged.

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
