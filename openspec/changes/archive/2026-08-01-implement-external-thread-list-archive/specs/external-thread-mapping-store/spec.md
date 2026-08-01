## ADDED Requirements

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
