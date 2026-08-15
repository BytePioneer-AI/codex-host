## ADDED Requirements

### Requirement: Snapshot reconciliation persists complete Native Turn order

Mapping Store SHALL atomically reconcile a ready external Thread against one complete ordered Turn mapping set derived from a validated Native Snapshot. The Native Snapshot is authoritative: reconciliation SHALL reuse an existing Host Turn ID only when its Native Turn identity still appears, SHALL allow newly discovered mappings at their Native positions, SHALL omit persisted mappings that the Snapshot no longer contains, SHALL adopt the Snapshot order and Checkpoint, and SHALL reject only a changed Host-to-Native association for an identity that remains.

#### Scenario: Native history adds Turns between existing mappings
- **WHEN** persisted mappings `[A, D]` are reconciled against a validated complete Snapshot mapping set `[A, B, C, D]`
- **THEN** the durable mapping order SHALL become `[A, B, C, D]` in one atomic replacement
- **AND** mappings `A` and `D` SHALL retain their existing Host Turn IDs

#### Scenario: Reconciled Snapshot is read repeatedly
- **WHEN** the same complete ordered mapping set is reconciled again after restart
- **THEN** Mapping Store SHALL return the existing record without changing its Revision
- **AND** the ordered Turn identities SHALL remain unchanged

#### Scenario: Native Snapshot omits or reorders a previously persisted mapping
- **WHEN** reconciliation receives a validated Snapshot that omits a persisted mapping or places remaining mappings in Native order
- **THEN** the durable mapping set SHALL become exactly that Snapshot order
- **AND** remaining Host-to-Native associations SHALL keep their existing Host Turn IDs

#### Scenario: Remaining identity association changes
- **WHEN** reconciliation keeps a Host Turn or Native Turn but pairs it with a different counterpart
- **THEN** Mapping Store SHALL reject the write as a mapping conflict
- **AND** the prior durable record, in-memory record, Revision, and indexes SHALL remain authoritative

#### Scenario: Ordered reconciliation replacement fails
- **WHEN** durable replacement fails while storing a valid complete ordered mapping set
- **THEN** the prior durable record, in-memory record, Revision, and indexes SHALL remain authoritative
