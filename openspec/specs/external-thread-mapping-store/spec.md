# external-thread-mapping-store Specification

## Purpose

Define strict, atomic, recoverable persistence for external Thread ownership, Native identity, Turn mappings, and Fork metadata without storing conversation content or credentials.

## Requirements

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

### Requirement: Ready Session replacement is one atomic identity update
Mapping Store SHALL support replacing a ready derived Thread's NativeSessionRef, complete retained Turn mapping set, and Fork source boundary in one validated atomic write. The replacement SHALL preserve the Host Thread ID and supplied retained Host Turn IDs, release the old Native indexes only after durable replacement, and leave the prior record and indexes authoritative on failure.

#### Scenario: Post-Fork rollback replacement succeeds
- **WHEN** Host commits an exact shorter derived Snapshot for an existing ready Thread
- **THEN** restart SHALL recover only the final Native Session identity, retained Turn mappings, and selected Fork source boundary
- **AND** no retained mapping SHALL refer to the temporary Native Session

#### Scenario: Post-Fork rollback replacement fails
- **WHEN** temp write, sync, backup, or atomic replacement fails during ready Session replacement
- **THEN** the prior ready Native Session, full mapping set, Fork source, and indexes SHALL remain authoritative

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

### Requirement: Mapping Store enumerates External Thread management metadata
Mapping Store SHALL return defensive copies of all valid stored External Thread records from its initialized in-memory state. Enumeration MUST NOT read a Native Session, call a Harness Adapter, or add conversation content to a stored or returned record.

#### Scenario: Ready records are enumerated after restart
- **WHEN** Mapping Store initializes from multiple valid ready Thread files
- **THEN** enumeration SHALL return their persisted ownership, Native identity, title, archive state, timeline metadata, Fork source, and Turn mappings
- **AND** the caller SHALL be unable to mutate the Store's authoritative records through the returned values

#### Scenario: Unrecoverable record was quarantined
- **WHEN** initialization has isolated a record whose primary and backup are both invalid
- **THEN** enumeration SHALL omit that record
- **AND** enumeration SHALL continue returning the remaining valid records

#### Scenario: Enumeration is inspected for forbidden content
- **WHEN** Host obtains the complete metadata list
- **THEN** no returned record SHALL contain Prompt, message body, Item snapshot, Tool output, Diff, Usage, Question answer, credential, or Codex history projection

### Requirement: Mapping Store updates archive state atomically
Mapping Store SHALL provide an idempotent archive-state update for an existing External Host Thread. A changed state SHALL use the same per-Thread serialization, strict validation, backup, atomic replacement, Revision, and in-memory index commit rules as other record updates.

#### Scenario: Ready Thread is archived
- **WHEN** Host sets a ready External Thread's archive state to true
- **THEN** the current record and its durable file SHALL contain `archived=true`
- **AND** Native Session identity, Turn mappings, Fork source, title, cwd, Harness ownership, and Native Transcript SHALL remain unchanged

#### Scenario: Archived Thread is unarchived after restart
- **WHEN** Host restarts and sets a previously archived record to false
- **THEN** a subsequent restart SHALL recover `archived=false`
- **AND** all other persisted identity and management fields SHALL remain available

#### Scenario: Requested archive state already matches
- **WHEN** Host requests the record's current archive state
- **THEN** Mapping Store SHALL return the current valid record as success
- **AND** it SHALL NOT perform an unnecessary durable replacement or Revision increment

#### Scenario: Archive replacement fails
- **WHEN** temp write, sync, backup, or atomic replacement fails while changing archive state
- **THEN** the prior archive state, durable record, in-memory record, Revision, and indexes SHALL remain authoritative
