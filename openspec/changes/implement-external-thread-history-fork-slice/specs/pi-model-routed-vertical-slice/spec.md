## ADDED Requirements

### Requirement: Pi history uses the active Entry branch
PiAdapter SHALL read Pi Entries and active leaf, traverse only the active parent chain, group each visible User Message Entry with its following native output until the next active User Entry, and produce a deterministic Host Snapshot without treating append order or `get_messages` as the complete history source.

#### Scenario: Pi Session contains an inactive branch
- **WHEN** `get_entries` contains Entries not present in the active leaf ancestry
- **THEN** PiAdapter SHALL omit those Entries from the current Snapshot
- **AND** NativeTurnRefs for the active branch SHALL remain based on stable User Entry IDs

#### Scenario: Pi history is read after native continuation
- **WHEN** the same Native Session gained Turns outside codexhost
- **THEN** a resumed Snapshot SHALL preserve prior identities and append mappings for the new active Turns

### Requirement: Pi emits real-time Native identity and Checkpoints
After a live Pi Turn reaches stable settlement, PiAdapter SHALL read the persisted active Entries, identify that Turn's stable User Entry, and emit a NativeTurnRef plus a distinct exact NativeCheckpointRef before successful Host completion is exposed.

#### Scenario: Successful live Pi Turn settles
- **WHEN** the User Entry and completed active context are visible in Pi Entries
- **THEN** terminal output SHALL contain the same NativeTurnRef and Checkpoint returned by a later Snapshot

#### Scenario: Pi Turn cannot be aligned
- **WHEN** the accepted persisted Turn cannot be uniquely matched to a new active User Entry
- **THEN** PiAdapter SHALL fail or fault instead of returning an unmappable success

### Requirement: Pi performs exact native Fork or Clone
PiAdapter SHALL resolve a stable source Turn Checkpoint against the latest active branch. It SHALL call native `fork` with the next active User Entry for a non-tail target and native `clone` for the active tail, then verify a distinct derived Session whose active context ends at the selected Turn.

#### Scenario: Non-tail Pi Turn is Forked
- **WHEN** the selected Turn has a later active User Entry
- **THEN** PiAdapter SHALL Fork before that next User Entry
- **AND** the derived Snapshot SHALL include the selected Turn but no later Turn

#### Scenario: Tail Pi Turn is Forked
- **WHEN** the selected Turn is the final active Turn
- **THEN** PiAdapter SHALL Clone the active Session into a distinct Native Session
- **AND** the derived Snapshot SHALL contain the complete source active context

#### Scenario: Source receives a later Turn after Checkpoint creation
- **WHEN** a formerly tail Checkpoint is Forked after more active history was appended
- **THEN** PiAdapter SHALL resolve it as a non-tail boundary without changing the Checkpoint identity

### Requirement: Pi Fork preserves source and current files
Native Pi Fork/Clone SHALL not change source Session identity, source Entry tree, or cwd files, and the derived Pi Session SHALL be independently continuable with the Model and Thinking state effective at its context boundary.

#### Scenario: Derived Pi Session continues
- **WHEN** a new Turn runs in the Forked Session
- **THEN** only the derived Entry tree SHALL append and the source tree SHALL remain unchanged

#### Scenario: Files differ from historical Turn
- **WHEN** cwd files changed after the selected Turn
- **THEN** Pi Fork SHALL leave those current files untouched
