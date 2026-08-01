## ADDED Requirements

### Requirement: Harness Fork capability distinguishes caller-selected cwd
Harness inspection and opened Session capabilities SHALL report exact history Fork and caller-selected target cwd support independently. `forkAcrossCwd=true` SHALL only be reported when `open(fork)` can bind a distinct exact Native Session to a cwd different from the source Session cwd.

#### Scenario: Adapter supports caller-selected cwd
- **WHEN** an Adapter reports `history.fork=true` and `history.forkAcrossCwd=true`
- **THEN** a valid `open(fork)` request with a different absolute target cwd SHALL create an exact distinct Native Session in that target cwd

#### Scenario: Adapter supports only source cwd
- **WHEN** an Adapter reports `history.fork=true` and `history.forkAcrossCwd=false` and receives a different target cwd
- **THEN** it SHALL return `unsupported` without creating a replacement Native Session

### Requirement: Fork cwd identifies the derived execution location
`ForkSessionInput.cwd` SHALL identify the target execution cwd of the derived Native Session. The Adapter SHALL use the Native Session source Ref only for history and ownership, and SHALL bind tools, project resources, future Turns, and persisted Native Session location to the target cwd.

#### Scenario: Cross-cwd derived Session continues
- **WHEN** a valid source Checkpoint is Forked into a caller-selected target cwd and a later Turn is started
- **THEN** the Turn and its tools SHALL execute against the target cwd
- **AND** the source cwd and source Native Session SHALL remain unchanged

#### Scenario: Target cwd cannot be bound
- **WHEN** the native Harness cannot create or confirm an exact derived Session in the requested cwd
- **THEN** `open(fork)` SHALL fail explicitly and SHALL NOT return a Session still bound to the source cwd

### Requirement: Adapter Fork does not manage Worktrees
HarnessAdapter Fork SHALL NOT create, delete, name, repair, or inspect Git Worktrees and SHALL NOT copy, roll back, restore, or snapshot project files. It SHALL only consume a caller-prepared target cwd and derive Native conversation state through an official Harness operation.

#### Scenario: Caller supplies a prepared Worktree
- **WHEN** the caller creates a Worktree before `open(fork)`
- **THEN** the Adapter SHALL treat its path as an ordinary target cwd
- **AND** closing or deleting the HarnessSession SHALL NOT delete that Worktree
