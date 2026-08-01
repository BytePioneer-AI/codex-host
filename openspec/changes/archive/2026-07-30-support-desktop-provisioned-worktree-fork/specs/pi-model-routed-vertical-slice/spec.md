## ADDED Requirements

### Requirement: Pi exact Fork supports a caller-selected cwd
PiAdapter SHALL implement caller-selected target cwd Fork through Pi's official cross-project Session Fork behavior and SHALL preserve exact Checkpoint semantics. It SHALL NOT rely on process cwd around `pi --session`, rewrite a Pi Session file, or create a Git Worktree.

#### Scenario: Tail Pi Session is Forked into another cwd
- **WHEN** `open(fork)` selects the source active tail and supplies a different target cwd
- **THEN** PiAdapter SHALL start a native `--fork` from the source Session in the target cwd
- **AND** the resulting distinct Session SHALL retain the complete active source history and execute later Turns in the target cwd

#### Scenario: Non-tail Pi Session is Forked into another cwd
- **WHEN** `open(fork)` selects a source Checkpoint with a later active User Entry and supplies a different target cwd
- **THEN** PiAdapter SHALL first create a native target-cwd Session from the source and then use Pi's native history Fork to exclude the selected Turn's successors
- **AND** the returned final Session Snapshot SHALL end exactly at the selected Checkpoint

#### Scenario: Cross-cwd Pi Fork cannot establish distinct identity
- **WHEN** native startup or exact slicing returns the source Session identity, retains a later Turn, or cannot confirm target-cwd Session state
- **THEN** PiAdapter SHALL close the attempted runtime and return an explicit failure without modifying the source Session
