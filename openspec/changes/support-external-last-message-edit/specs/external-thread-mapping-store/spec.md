## ADDED Requirements

### Requirement: Last-turn edit replaces a ready Session atomically
Mapping Store SHALL provide a dedicated atomic replacement for a ready External Thread after last-turn rollback. The replacement SHALL require a distinct NativeSessionRef and Turn mappings whose Host Turn IDs are the current mapping set with exactly its final entry removed; the replacement mapping set MAY be empty. It SHALL preserve the Host Thread ID, Fork source, cwd, title, archive state, transport carrier, timeline metadata, and all other management fields.

#### Scenario: Last remaining Turn is removed
- **WHEN** Host replaces a ready one-Turn External Thread with a valid distinct zero-Turn Native Session
- **THEN** the durable record SHALL contain the new NativeSessionRef and an empty Turn mapping set
- **AND** a restart SHALL recover that same ready zero-Turn Thread

#### Scenario: Retained mappings are replaced
- **WHEN** Host replaces a ready multi-Turn External Thread after removing its final Turn
- **THEN** every retained Host Turn ID SHALL stay unchanged while its Native Turn and optional Checkpoint refs SHALL identify the replacement Native Session
- **AND** the prior Native indexes SHALL be released only after the durable replacement succeeds

#### Scenario: Last-turn replacement fails
- **WHEN** validation, temp write, sync, backup, or atomic replacement fails
- **THEN** the previous ready Native Session, complete Turn mappings, Fork source, Revision, and indexes SHALL remain authoritative
