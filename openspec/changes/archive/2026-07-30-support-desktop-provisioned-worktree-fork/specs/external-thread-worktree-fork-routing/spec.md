## ADDED Requirements

### Requirement: External Fork accepts a Desktop-provisioned target cwd
When an external Thread Fork carries an absolute cwd different from the source and its Adapter reports caller-selected cwd support, Host SHALL create the derived Host Thread and Native Session in that target cwd. Host SHALL persist the target on the derived record and SHALL NOT create or manage a Git Worktree.

#### Scenario: Desktop Forks into a prepared Worktree
- **WHEN** Desktop has prepared an absolute Worktree root and sends an external `thread/fork` with that root as cwd and in runtime workspace roots
- **THEN** Host SHALL Fork the exact source Checkpoint through the source HarnessAdapter using that target cwd
- **AND** the Fork response and persisted derived Thread SHALL identify the target cwd

#### Scenario: Target cwd capability is unavailable
- **WHEN** an external Fork changes cwd but the source Adapter does not report caller-selected cwd support
- **THEN** Host SHALL reject the request explicitly without creating a Host Thread, Native Session, official shadow Thread, or Worktree

### Requirement: Cross-cwd Fork preserves ownership and location safety
A target-cwd external Fork SHALL retain source Harness ownership and SHALL reject a non-empty rollout path, incompatible Model carrier, changed Model Provider, relative target cwd, or supplied runtime workspace roots that are relative or omit the changed target. These failures SHALL NOT fall through to official Codex.

#### Scenario: Worktree Fork carries only an allowed location change
- **WHEN** an external Fork changes only cwd and absolute runtime workspace roots while preserving source ownership and transport Model
- **THEN** Host SHALL accept the location change and keep the source Harness and Native Session ownership immutable

#### Scenario: Fork attempts to replace source Native location
- **WHEN** the request carries a non-empty rollout path or another Harness transport carrier together with a target cwd
- **THEN** Host SHALL reject it without opening an Adapter Session or forwarding it to Codex

### Requirement: Cross-cwd post-Fork rollback retains derived location
For a supported Desktop unbounded Fork followed by bounded `thread/rollback`, source and derived cwd equality SHALL NOT be part of lineage proof. Host SHALL resolve the retained Checkpoint from the source mappings and create the final Native Session in the already persisted derived target cwd.

#### Scenario: Worktree tail Fork is rolled back to an earlier Turn
- **WHEN** Desktop tail-Forks an external source into a prepared Worktree and rolls the untouched derived prefix back by a valid number of Turns
- **THEN** Host SHALL keep the same derived Host Thread ID, retained Host Turn IDs, and Worktree cwd
- **AND** it SHALL replace the temporary Session with an exact distinct Native Session Forked from the retained source Checkpoint into that cwd

#### Scenario: Source and Worktree Threads continue independently
- **WHEN** the cross-cwd rollback succeeds and later Turns are sent to source and derived Threads
- **THEN** source Turns SHALL use the source Native Session and cwd
- **AND** derived Turns SHALL use the final derived Native Session and Worktree cwd

### Requirement: Official Codex Worktree Fork remains transparent
Host SHALL determine Worktree Fork ownership by source Thread before decoding or validating external-only target cwd constraints.

#### Scenario: Codex-owned Thread is Forked into a Worktree
- **WHEN** `thread/fork.threadId` is not owned by a mapped external Thread
- **THEN** Host SHALL forward the original frame unchanged to the official app-server
