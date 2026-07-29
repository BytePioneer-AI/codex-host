## ADDED Requirements

### Requirement: Mapping Store persists only external identity and management metadata
Mapping Store SHALL persist one strict versioned record per external Host Thread containing ownership, Native Session identity, Native Turn mappings, optional Fork Anchors, Fork source, cwd, title, archive state, transport carrier, and required Desktop timeline metadata. It MUST NOT persist conversation content or credentials.

#### Scenario: Ready external Thread is stored
- **WHEN** Host commits an external Thread with Native identity and Turn mappings
- **THEN** a restart SHALL recover the same Host Thread, Harness, NativeSessionRef, ordered Host Turn mappings, Checkpoints, `ephemeral`, and `historyMode`

#### Scenario: Record is inspected for forbidden content
- **WHEN** a record is serialized
- **THEN** it SHALL contain no Prompt, message body, normalized Transcript, Item snapshot, Tool output, Diff, Question answer, Access Token, API Key, or OAuth Secret

### Requirement: Native and Host identities remain unique and consistent
The Store SHALL enforce unique Host Thread IDs, create request IDs, Native Session refs, Host Turn IDs, and NativeTurnRefs, and SHALL require every Native Ref in one record to match that record's Harness and Native Session.

#### Scenario: Conflicting Turn mapping is written
- **WHEN** an existing Host Turn or NativeTurnRef is associated with a different counterpart
- **THEN** the Store SHALL reject the write without changing persisted or in-memory state

#### Scenario: Derived Native Session reuses native entry keys
- **WHEN** a Forked Session contains entry keys also present in its source but has a distinct Native Session ID
- **THEN** the Store SHALL treat the derived NativeTurnRefs as distinct and allocate derived Host Turn mappings

### Requirement: Writes are atomic and single-writer
Mapping Store SHALL acquire one exclusive process lock, serialize writes per Thread, validate each next record, replace files atomically on the same filesystem, and update in-memory indexes only after durable replacement succeeds.

#### Scenario: Second Host opens the same Store
- **WHEN** a live writer already owns the Store lock
- **THEN** initialization SHALL fail with a clear locked error and SHALL NOT write records

#### Scenario: Replacement fails
- **WHEN** temp write, sync, backup, or atomic replacement fails
- **THEN** the prior valid record and indexes SHALL remain authoritative

### Requirement: Startup recovers bounded incomplete state
Initialization SHALL remove abandoned temp files, recover a bad primary from its valid backup, isolate unrecoverable records, remove creating records without Native identity, and rebuild all indexes before serving Host operations.

#### Scenario: Primary record is malformed
- **WHEN** its latest backup is valid
- **THEN** initialization SHALL restore the valid record and preserve its mappings

#### Scenario: Provisional create has no NativeSessionRef
- **WHEN** Host restarts after allocating only a provisional external Thread
- **THEN** initialization SHALL remove that provisional mapping rather than expose a ready Thread

### Requirement: Fork persistence is committed before success
Host SHALL create a provisional derived record before native Fork and SHALL commit the derived NativeSessionRef, Snapshot Turn mappings, Fork Anchors, and ready state before returning Fork success.

#### Scenario: Native Fork fails
- **WHEN** Adapter open(fork) returns an error
- **THEN** the provisional Host record SHALL be removed and the source record SHALL remain unchanged

#### Scenario: Store commit fails after native Fork
- **WHEN** a distinct derived Native Session exists but its Host record cannot be committed
- **THEN** Host SHALL close the derived runtime, return failure, remove provisional Host state, and SHALL NOT delete the native Session history
