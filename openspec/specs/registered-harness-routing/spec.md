# registered-harness-routing Specification

## Purpose
TBD - created by archiving change implement-registered-harness-text-vertical-slice. Update Purpose after archive.
## Requirements
### Requirement: External Harness create routing uses a finite Protocol Core registry
Protocol Core SHALL decode official Codex Models and the finite native transport tokens for Pi and Claude Code. Each external token SHALL identify one external Harness ID without exposing Adapter implementation or native Model configuration.

#### Scenario: Pi transport token is decoded
- **WHEN** `thread/start.model` is `codexhost/pi-native`
- **THEN** Protocol Core SHALL route the create to external Harness `pi`

#### Scenario: Claude transport token is decoded
- **WHEN** `thread/start.model` is `codexhost/claude-code-native`
- **THEN** Protocol Core SHALL route the create to external Harness `claude-code`

#### Scenario: Official Model is decoded
- **WHEN** `thread/start.model` is not a registered external transport token
- **THEN** Protocol Core SHALL classify it as official Codex Model traffic without altering the Model value

### Requirement: Host owns external Threads through registered HarnessAdapters
Host Runtime SHALL route all external create, turn, interrupt, read, rename, delete, output, fault, and close operations through one external Thread implementation keyed by Harness ID. It MUST NOT contain Pi RPC or Claude SDK event mapping.

#### Scenario: Registered Claude Thread starts
- **WHEN** a Claude transport create reaches a Host with a registered Claude Code Adapter
- **THEN** Host SHALL open that Adapter through HarnessAdapter and return an external Codex Thread
- **AND** later Turn outputs SHALL pass through the same CodexTurnProjector used by Pi

#### Scenario: Two concrete Adapters are registered
- **WHEN** Pi and Claude Code Threads coexist in one Host
- **THEN** each Thread SHALL remain bound to its creating HarnessSession
- **AND** operations on one Thread SHALL never invoke the other Adapter

#### Scenario: Valid transport token has no Adapter
- **WHEN** an external token reaches a Host without its Adapter registration
- **THEN** Host SHALL return an explicit unavailable error
- **AND** it SHALL NOT forward that request or its future content to official Codex

### Requirement: Existing response ordering and lifecycle projection are reused
The generic external Thread path SHALL retain response-before-notification ordering, HarnessSession output ordering, current Codex Item/Turn projection, process-local thread/read, local rename/delete, and bounded Host shutdown for every registered external Harness.

#### Scenario: Early Claude outputs race acceptance response
- **WHEN** Claude Harness outputs are queued before `turn/start` execute resolves
- **THEN** Host SHALL write the JSON-RPC response before forwarding the first lifecycle notification

#### Scenario: Claude cancellation output races interrupt response
- **WHEN** cancellation terminal output is queued before `turn/interrupt` response
- **THEN** Host SHALL write the interrupt response first
- **AND** the projected Turn SHALL later complete interrupted exactly once

#### Scenario: Host closes mixed external Threads
- **WHEN** Host exits with Pi and Claude Sessions open
- **THEN** it SHALL close every Session and both Adapters without depending on Harness-specific branches

### Requirement: Claude Host registration is explicitly development-gated
The production composition root SHALL always register Pi as before and SHALL register Claude Code only when an explicit development environment switch is enabled. The default Agent SHALL remain Codex or Pi.

#### Scenario: Default Host starts
- **WHEN** the Claude development switch is absent
- **THEN** Host SHALL not construct a Claude Code Adapter
- **AND** all existing Codex and Pi routing behavior SHALL remain unchanged

#### Scenario: Development Host starts with Claude
- **WHEN** the Claude development switch is explicitly enabled
- **THEN** Host SHALL register one Claude Code Adapter using the user-installed executable configuration
- **AND** the Claude transport token SHALL become routable

### Requirement: Validation distinguishes Host proof from Desktop proof
Hermetic Host tests SHALL use two Fake HarnessAdapters. Real Adapter tests and real Desktop tests SHALL be separately and explicitly enabled, bounded, and privacy-preserving.

#### Scenario: Real Adapter Host Gate passes
- **WHEN** the explicit real Adapter Gate sends a synthetic text Turn through Host Runtime
- **THEN** the report SHALL confirm Claude selection, one Native Session, ordered text projection, and terminal outcome without recording content or complete IDs

#### Scenario: Real Codex Desktop Gate passes
- **WHEN** a user explicitly enables Claude in the controlled Renderer, submits a synthetic Prompt, cancels or completes it, and continues the same Thread
- **THEN** sanitized Renderer and Host observations SHALL associate the Claude create and Turn
- **AND** only then MAY the change claim a real Claude-to-Codex-UI text chain

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
