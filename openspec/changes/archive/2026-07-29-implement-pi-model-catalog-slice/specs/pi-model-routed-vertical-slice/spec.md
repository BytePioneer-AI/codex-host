## ADDED Requirements

### Requirement: Selected Pi transport Model preserves Harness ownership
An explicitly selected Pi Model carrier SHALL route to the Pi Harness exactly like `codexhost/pi-native`, SHALL carry only an opaque Harness Model Ref, and SHALL NOT be treated as a Codex Model, Pi Provider, Account, Billing Source, or permission route.

#### Scenario: New Pi Thread carries an explicit Model Ref
- **WHEN** `thread/start.params.model` contains a valid selected Pi transport carrier
- **THEN** Protocol Facade decodes Pi Harness ownership and the opaque Model Ref in the same request
- **AND** it opens the Pi Session with that Ref without forwarding the request to the official Codex app-server

#### Scenario: Selected carrier is malformed
- **WHEN** a `thread/start` Model resembles a selected Pi carrier but has a missing, oversized, or invalid Model Ref
- **THEN** Protocol Facade rejects the Pi creation explicitly rather than forwarding it as an official Codex Model

#### Scenario: Later Turn carries the selected Pi carrier
- **WHEN** `turn/start` for an existing Pi Thread carries a valid selected Pi Model override
- **THEN** Host verifies or applies that Ref through the owned Pi Session before accepting the Agent Loop
- **AND** Thread Harness ownership remains Pi regardless of the current page Model state

### Requirement: Pi Model selection never falls back to Codex
Pi Model inspection, create-time application, and Idle Session selection SHALL execute only through PiAdapter and Pi native RPC behavior. Any failure SHALL remain a Pi error and SHALL NOT retry, inspect, or execute through the Codex Harness.

#### Scenario: Draft-selected Pi Model is unavailable at first Turn
- **WHEN** Pi rejects or cannot confirm the Model selected in the create carrier
- **THEN** the first Turn is rejected before acceptance or fails with an explicit Pi error according to the established acceptance boundary
- **AND** the official Codex Agent Loop receives neither the Thread creation nor the Turn

#### Scenario: Existing Session selection is busy
- **WHEN** a Model selection request targets a Pi Session with an active Turn
- **THEN** Host returns the normalized busy error and leaves the current Pi Model and Turn unchanged

#### Scenario: Codex request remains official
- **WHEN** a Codex-owned Thread uses an official Model value
- **THEN** the request continues transparently through the stock app-server and PiAdapter is not inspected or opened
