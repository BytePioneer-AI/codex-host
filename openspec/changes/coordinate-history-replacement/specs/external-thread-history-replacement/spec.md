## ADDED Requirements

### Requirement: Host replacement owns exclusive Session access

The Host SHALL exclude concurrent public Session calls and in-flight output projection while preparing history replacement.

#### Scenario: A usage refresh is still running

- **WHEN** an asynchronous usage refresh has not completed
- **THEN** replacement admission fails without starting native derivation

#### Scenario: New input races with an edit

- **WHEN** replacement already owns the Session
- **THEN** new input and another replacement are rejected before native execution

#### Scenario: Native output arrives during preparation

- **WHEN** the native Session emits output while replacement is preparing
- **THEN** replacement is invalidated and the original consumer subsequently receives that output

### Requirement: Candidate ownership and retained semantics are validated

The Host SHALL validate candidate ownership before accessing it and SHALL validate retained history, native identity and current configuration before commit.

#### Scenario: An Adapter returns another Thread's Session

- **WHEN** a candidate aliases an owned Session or native identity
- **THEN** the Host neither mutates nor closes that owned resource

#### Scenario: A same-ID last-Turn wrapper is supported

- **WHEN** a distinct candidate wrapper retains the current native identity and valid shorter history
- **THEN** the Host preserves existing last-Turn support without requiring a new fence declaration

#### Scenario: A fixed Model already matches

- **WHEN** a non-selectable candidate Model matches the current configuration
- **THEN** replacement can proceed without a selection command

### Requirement: Replacement failure recovers from the persisted authority

The Host SHALL close and drain its source wrapper before committing, bound unconfirmed cleanup waits, and recover according to the durable record.

#### Scenario: Source shutdown is unconfirmed

- **WHEN** close fails or times out
- **THEN** the Store is unchanged and the retired wrapper cannot accept further input

#### Scenario: Store commit fails after confirmed source close

- **WHEN** replacement persistence fails
- **THEN** the candidate is closed and the next request resumes the original persisted identity through a fresh wrapper

#### Scenario: Publication fails after Store commit

- **WHEN** Runtime registration fails after replacement persistence succeeds
- **THEN** the new persisted identity remains authoritative and Runtime recovery never revives the old source

#### Scenario: Source output drain times out after native close

- **WHEN** native close succeeds but the old output consumer does not finish within the cleanup timeout
- **THEN** the Store is unchanged and the retired source remains loaded to prevent a fresh wrapper racing its late projections
- **AND** late completion does not automatically unload that retired source
