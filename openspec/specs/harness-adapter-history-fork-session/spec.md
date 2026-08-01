# harness-adapter-history-fork-session Specification

## Purpose

Define stable historical identity, Snapshot, resume, exact Fork, and capability semantics for UI-independent HarnessAdapter Sessions.

## Requirements

### Requirement: Harness Sessions expose stable historical identity
Every history-capable production external HarnessSession SHALL provide an idle full Snapshot in which each visible Native Turn has one stable NativeTurnRef, deterministic final Item identities, an evidence-based historical outcome, and an optional NativeCheckpointRef only when that exact position can be Forked. An explicitly development-gated Adapter whose history mapper is not implemented MAY return `unsupported` from `readSnapshot()`, but it SHALL report no Fork capability.

#### Scenario: Snapshot is read repeatedly
- **WHEN** a caller reads the same unchanged Native Session Snapshot more than once
- **THEN** Turn order, NativeTurnRefs, Item IDs, outcomes, and provided Checkpoints SHALL remain equal

#### Scenario: Native history is appended
- **WHEN** later Native Turns are appended without modifying prior active history
- **THEN** every prior NativeTurnRef and Item ID SHALL remain stable and only new Turns SHALL be added

#### Scenario: Historical outcome is uncertain
- **WHEN** native history does not prove success, failure, or cancellation
- **THEN** the Snapshot SHALL use an explicit unknown outcome rather than report success

### Requirement: Live terminal identity aligns with Snapshot identity
A live accepted Turn that becomes part of Native history SHALL emit a stable NativeTurnRef and any supported exact Checkpoint before Host-visible completion. When the Session supports Snapshot reads, a later Snapshot SHALL return the same NativeTurnRef and Checkpoint for that logical Turn.

#### Scenario: Live Turn is read from history
- **WHEN** a completed live Turn is later returned by `readSnapshot()`
- **THEN** its terminal NativeTurnRef SHALL equal the Snapshot NativeTurnRef
- **AND** any terminal Checkpoint SHALL equal the Snapshot Checkpoint

#### Scenario: Accepted Turn leaves no stable history
- **WHEN** an Adapter cannot establish the stable identity required for a Turn that native history persisted
- **THEN** it SHALL fail or fault the Turn instead of emitting an unmappable successful terminal

#### Scenario: Development-gated Adapter has no history mapper
- **WHEN** a development-gated Adapter confirms that a create-mode Turn's caller-assigned Native Turn identity entered native history but Snapshot, resume, and Fork remain unsupported
- **THEN** its terminal SHALL emit that stable NativeTurnRef without a Checkpoint
- **AND** `readSnapshot()` and `open(resume|fork)` SHALL continue to return explicit `unsupported` results

### Requirement: Resume opens the referenced Native Session
`HarnessAdapter.open(resume)` SHALL validate the opaque NativeSessionRef, open that exact Session without changing Harness ownership or native configuration, and allow an immediate idle Snapshot read.

#### Scenario: Valid Session is resumed
- **WHEN** resume receives a readable NativeSessionRef belonging to the Adapter and matching cwd
- **THEN** the returned HarnessSession SHALL identify the same Native Session and expose its latest full Snapshot

#### Scenario: Session cannot be resumed
- **WHEN** the Ref belongs to another Harness, the Session is missing, or cwd cannot be safely matched
- **THEN** open SHALL return an explicit error and SHALL NOT create a replacement Session

### Requirement: Fork opens a distinct exact Native Session
`HarnessAdapter.open(fork)` SHALL validate the source NativeSessionRef and NativeCheckpointRef, create a distinct Native Session whose active context ends exactly at that Checkpoint, leave the source unchanged, and return a HarnessSession with a stable derived NativeSessionRef.

#### Scenario: Exact Fork succeeds
- **WHEN** a valid exact Checkpoint from an idle source Session is Forked
- **THEN** the returned Session SHALL have a different Native Session identity
- **AND** its Snapshot SHALL include the selected Turn and its ancestors but no later source Turn

#### Scenario: Derived Session continues
- **WHEN** a Turn is started after Fork
- **THEN** it SHALL execute in the derived Native Session without appending to the source

#### Scenario: Source or Checkpoint is invalid
- **WHEN** the source and Checkpoint Harness or Session identities differ, the Checkpoint is stale, or exact Fork is unavailable
- **THEN** open SHALL return an explicit error and SHALL NOT modify the source

### Requirement: Fork capability is structural and honest
Harness inspection and opened Session capabilities SHALL report `history.fork` only when the Adapter can consume its own emitted Checkpoints through `open(fork)`. A false capability SHALL produce explicit unsupported behavior without a placeholder native operation.

#### Scenario: Adapter does not implement history Fork
- **WHEN** a caller requests Fork from an Adapter with `history.fork=false`
- **THEN** the Adapter SHALL return `unsupported` and SHALL NOT copy visible messages or create a fake Native Session

### Requirement: Fork never changes project files
HarnessAdapter Fork SHALL only derive Native conversation context. It SHALL NOT rewind, copy, restore, patch, snapshot, or create a Worktree for project files.

#### Scenario: Files changed after the selected Turn
- **WHEN** a Session is Forked from an earlier Turn after the cwd has newer file contents
- **THEN** the derived Session SHALL use the current cwd contents without modifying them during Fork
