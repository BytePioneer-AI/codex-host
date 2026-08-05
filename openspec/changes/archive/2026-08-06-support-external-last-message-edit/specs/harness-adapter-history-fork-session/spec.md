## ADDED Requirements

### Requirement: Last-turn rollback opens a distinct exact Native Session
Harness inspection and opened Session capabilities SHALL report `history.rollbackLastTurn=true` only when `HarnessAdapter.open(rollbackLastTurn)` can derive a distinct Native Session whose active history is the input Native Session's exact current history without its final Turn. The operation SHALL require that current Native Session to be idle with at least one Turn, SHALL allow the derived Snapshot to contain zero Turns, SHALL preserve its current confirmed Model and Thinking configuration, and SHALL NOT modify the input Native Session or project files.

#### Scenario: Last Turn is removed from a multi-Turn Session
- **WHEN** a caller opens `rollbackLastTurn` for an idle source Session containing multiple Turns
- **THEN** the returned Session SHALL have a different Native Session identity and an exact Snapshot containing every source Turn except the final Turn
- **AND** the derived Session's effective Model and Thinking configuration SHALL equal the input Native Session's current confirmed configuration
- **AND** the input Session Snapshot and current project files SHALL remain unchanged

#### Scenario: Only Turn is removed
- **WHEN** a caller opens `rollbackLastTurn` for an idle source Session containing exactly one Turn
- **THEN** the returned distinct Session Snapshot SHALL contain zero Turns
- **AND** it SHALL preserve the input Native Session's current confirmed Model and Thinking configuration and remain available for a later Turn

#### Scenario: Capability is unavailable
- **WHEN** an Adapter reports `history.rollbackLastTurn=false`, or the source Session is active or empty
- **THEN** `open(rollbackLastTurn)` SHALL return an explicit unsupported or invalid-state result before exposing a replacement Session
- **AND** it SHALL NOT replay visible messages or modify the source
