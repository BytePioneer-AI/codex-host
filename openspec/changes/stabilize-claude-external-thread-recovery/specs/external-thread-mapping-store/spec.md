## ADDED Requirements

### Requirement: Snapshot reconciliation persists complete Native Turn order

Mapping Store SHALL atomically reconcile a ready external Thread against one complete ordered Turn mapping set derived from a validated Native Snapshot. Reconciliation SHALL retain every existing Host-to-Native Turn association in its existing relative order, SHALL allow newly discovered mappings to be inserted at their Native Snapshot positions, and SHALL reject removals, reordered existing identities, changed associations, or changed Checkpoints without modifying durable or in-memory state.

#### Scenario: Native history adds Turns between existing mappings
- **WHEN** persisted mappings `[A, D]` are reconciled against a validated complete Snapshot mapping set `[A, B, C, D]`
- **THEN** the durable mapping order SHALL become `[A, B, C, D]` in one atomic replacement
- **AND** mappings `A` and `D` SHALL retain their existing Host Turn IDs

#### Scenario: Reconciled Snapshot is read repeatedly
- **WHEN** the same complete ordered mapping set is reconciled again after restart
- **THEN** Mapping Store SHALL return the existing record without changing its Revision
- **AND** the ordered Turn identities SHALL remain unchanged

#### Scenario: Complete mapping set omits or reorders existing identity
- **WHEN** reconciliation omits an existing mapping, changes its Host-to-Native association, changes an existing Checkpoint, or places existing mappings in another relative order
- **THEN** Mapping Store SHALL reject the write as a mapping conflict
- **AND** the prior durable record, in-memory record, Revision, and indexes SHALL remain authoritative

#### Scenario: Ordered reconciliation replacement fails
- **WHEN** durable replacement fails while storing a valid complete ordered mapping set
- **THEN** the prior durable record, in-memory record, Revision, and indexes SHALL remain authoritative
