## ADDED Requirements

### Requirement: Generic external routing consumes persisted ownership
Host Runtime SHALL consult the same external Thread repository for create, turn, interrupt, read, resume, rename, delete, inspect, and Fork routing. A persisted external resource MUST remain external when its Session is not currently loaded and MUST never fall through to official Codex.

#### Scenario: Persisted Thread is not loaded
- **WHEN** a resource request names a persisted Pi Thread after Host restart
- **THEN** Host SHALL select PiAdapter and resume or reject explicitly according to the operation
- **AND** it SHALL NOT forward the request to official Codex

### Requirement: Generic external Sessions support capability-driven history and Fork
Host Runtime SHALL use only HarnessAdapter Snapshot, Native Ref, capability, resume, and Fork interfaces for external history operations. It MUST NOT inspect Pi Entry locators, Claude UUIDs, or other native Fork payloads.

#### Scenario: Two Adapters have different Fork support
- **WHEN** Pi reports exact Fork and development-gated Claude reports unsupported
- **THEN** the same Host route SHALL execute Pi Fork and return an explicit Claude unsupported error without Harness-specific event mapping

### Requirement: Generic external routing owns bounded post-Fork rollback
Host Runtime SHALL use persisted ownership and the same HarnessAdapter Snapshot and Fork interfaces to handle the supported Desktop's post-Fork `thread/rollback` for an untouched derived external prefix. It MUST NOT add Pi Entry, Session file, or native rollback logic to Host, and an unsupported external rollback MUST NOT fall through to Codex.

#### Scenario: Registered Adapter realizes post-Fork rollback
- **WHEN** a mapped derived Thread still equals its persisted source prefix and its Adapter supports exact Fork
- **THEN** the generic Host route SHALL open the final exact Session through `HarnessAdapter.open(fork)` and replace the derived runtime
- **AND** no Harness-specific rollback command SHALL be required

### Requirement: Persisted completion precedes Desktop terminal projection
For every external Harness, Host SHALL persist a live Turn's NativeTurnRef and optional Checkpoint before projecting the corresponding successful terminal to Desktop. Store failure SHALL become an explicit failed lifecycle and MUST NOT expose an unpersisted Fork Anchor.

#### Scenario: Turn mapping write fails
- **WHEN** an Adapter emits a successful terminal with stable Native identity but Mapping Store cannot commit it
- **THEN** Host SHALL not project that success as a Forkable completed Turn
