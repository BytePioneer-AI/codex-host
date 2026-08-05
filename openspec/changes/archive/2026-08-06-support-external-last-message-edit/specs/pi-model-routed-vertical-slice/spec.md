## ADDED Requirements

### Requirement: Pi derives history before the current last Turn
PiAdapter SHALL report `history.rollbackLastTurn=true` and implement `open(rollbackLastTurn)` through Pi structured native Session operations. It SHALL create a distinct Native Session, exclude the final active-branch User Turn and its descendants, preserve the input Native Session's current confirmed Model and Thinking configuration, verify the exact resulting Snapshot, and SHALL NOT rewrite Session files, replay visible text, or modify the input Session history or project files.

#### Scenario: Pi multi-Turn Session rolls back its last Turn
- **WHEN** `open(rollbackLastTurn)` targets an idle Pi Session with multiple active-branch User Turns
- **THEN** PiAdapter SHALL return a distinct Session whose Snapshot preserves every prior Turn and excludes only the final Turn
- **AND** the returned Session's effective Model and Thinking configuration SHALL equal the input Native Session's current confirmed configuration
- **AND** the input Session Snapshot SHALL remain unchanged

#### Scenario: Pi one-Turn Session rolls back to empty history
- **WHEN** `open(rollbackLastTurn)` targets an idle Pi Session with one active-branch User Turn
- **THEN** PiAdapter SHALL return a distinct Session whose Snapshot contains zero Turns
- **AND** that Session SHALL preserve the input Native Session's current confirmed Model and Thinking configuration and accept the edited replacement Turn

#### Scenario: Pi cannot prove the exact native result
- **WHEN** Pi does not create a distinct identity, the final Snapshot is not exactly one Turn shorter, the source boundary is unavailable, or the current Model and Thinking configuration cannot be preserved
- **THEN** PiAdapter SHALL close the attempted Runtime and return an explicit failure
- **AND** it SHALL NOT fall back to text replay, Session file mutation, or a different Harness
