## ADDED Requirements

### Requirement: Source-preserving message edit

The Adapter SHALL derive rollback history into a distinct durable Session without reverting workspace files or mutating source history, and SHALL verify retained history and settings before returning it.

#### Scenario: Editing the first Turn

- **WHEN** the only Turn is rolled back
- **THEN** the candidate has empty history and current settings, remains resumable after restart, and the source and current files remain intact

#### Scenario: Invalid native derivation

- **WHEN** native Fork returns a reused identity, changed source or mismatching retained history
- **THEN** opening fails and an owned source Session is never deleted as cleanup

### Requirement: Idle-confirmed cancellation

The Adapter SHALL wait for native idle before projecting cancellation completion.

#### Scenario: Abort error arrives while busy

- **WHEN** the native Session emits an abort error while still busy
- **THEN** the current Turn remains active until native idle is confirmed and another Turn cannot start
