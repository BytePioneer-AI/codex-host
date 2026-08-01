## ADDED Requirements

### Requirement: Host reports persisted Thread ownership without restoring Sessions
Host Runtime SHALL handle the fixed `codexhost/thread/ownership/list` request by reading external Thread ownership directly from the Mapping Store repository. It SHALL return exactly one ordered ownership entry per requested Thread ID, classify a stored record as its immutable external Harness and an absent record as Codex, and MUST NOT call an Adapter, restore a HarnessSession, read a Snapshot, or forward the request to official Codex.

#### Scenario: Batch contains Codex and external Threads
- **WHEN** a valid ownership request contains an official Thread ID, a persisted Pi Thread ID, and a persisted development-gated Claude Code Thread ID
- **THEN** Host SHALL return Codex, Pi, and Claude Code ownership in the same order as requested
- **AND** it SHALL NOT open either external Adapter

#### Scenario: Persisted external runtime is unloaded
- **WHEN** ownership is requested for a stored external Thread after Host restart
- **THEN** Host SHALL report the stored Harness without resuming the Native Session or reading history

#### Scenario: Ownership metadata cannot be read
- **WHEN** Mapping Store lookup fails for any requested Thread
- **THEN** Host SHALL fail the complete fixed request explicitly rather than return a partial result or forward it to Codex
