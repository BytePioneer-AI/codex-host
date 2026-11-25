## MODIFIED Requirements

### Requirement: Mapping Store persists only external identity and management metadata
Mapping Store SHALL persist one strict versioned record per external Host Thread containing ownership, Native Session identity, Native Turn mappings, optional Fork Anchors, Fork source, cwd, title, archive state, transport carrier, and required Desktop timeline metadata. It SHALL additionally persist Delegation relations that associate a parent Host Thread with a child Host Thread created for another Harness, together with their Harness identities, status, and optional originating Request ID. It MUST NOT persist conversation content or credentials.

#### Scenario: Ready external Thread is stored
- **WHEN** Host commits an external Thread with Native identity and Turn mappings
- **THEN** a restart SHALL recover the same Host Thread, Harness, NativeSessionRef, ordered Host Turn mappings, Checkpoints, `ephemeral`, and `historyMode`

#### Scenario: Record is inspected for forbidden content
- **WHEN** a record is serialized
- **THEN** it SHALL contain no Prompt, message body, normalized Transcript, Item snapshot, Tool output, Diff, Question answer, Access Token, API Key, or OAuth Secret

#### Scenario: Delegation relation is stored
- **WHEN** Host commits a Delegation between a parent Host Thread and a child Host Thread owned by a different Harness
- **THEN** a restart SHALL recover the parent and child Host Thread identities, both Harness identities, the status, and any originating Request ID that was supplied
- **AND** the relation SHALL remain separate from the Subagent association so the child Thread stays an ordinary listable external Thread
- **AND** neither Thread's Native Session identity SHALL be shared, copied, or migrated between them

### Requirement: Native and Host identities remain unique and consistent
The Store SHALL enforce unique Host Thread IDs, create request IDs, Native Session refs, Host Turn IDs, and NativeTurnRefs, and SHALL require every Native Ref in one record to match that record's Harness and Native Session. When a caller supplies a create request ID, the Store SHALL treat a repeated identifier as a reference to the existing Host Thread rather than as a conflict.

#### Scenario: Conflicting Turn mapping is written
- **WHEN** an existing Host Turn or NativeTurnRef is associated with a different counterpart
- **THEN** the Store SHALL reject the write without changing persisted or in-memory state

#### Scenario: Derived Native Session reuses native entry keys
- **WHEN** a Forked Session contains entry keys also present in its source but has a distinct Native Session ID
- **THEN** the Store SHALL treat the derived NativeTurnRefs as distinct and allocate derived Host Turn mappings

#### Scenario: Caller supplies a repeated create request ID
- **WHEN** a caller creates a Thread with a create request ID that already identifies a stored Thread
- **THEN** the Store SHALL resolve to that existing Host Thread
- **AND** it SHALL NOT allocate a second Host Thread or a second Native Session
