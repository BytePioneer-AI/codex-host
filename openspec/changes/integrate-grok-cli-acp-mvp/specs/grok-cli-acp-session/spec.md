## ADDED Requirements

### Requirement: Grok Adapter SHALL use ACP behind the HarnessAdapter seam

The system SHALL register Grok CLI as Harness `grok`. GrokAdapter SHALL implement the existing `HarnessAdapter` contract and SHALL communicate with the installed Grok CLI through ACP v1 JSON-RPC over a bounded stdio process. ACP and `x.ai/*` payloads MUST remain inside the Grok Adapter package.

#### Scenario: Grok is installed
- **WHEN** Grok inspection starts and `grok agent --no-leader stdio` returns a valid ACP initialization response
- **THEN** GrokAdapter SHALL return a normalized ready inspection and close temporary inspection resources

#### Scenario: Grok is unavailable
- **WHEN** the executable is missing, authentication is required, initialization fails, or the process exits
- **THEN** GrokAdapter SHALL return the corresponding normalized Harness error
- **AND** Codex, Pi, and Claude Code routing SHALL remain available

### Requirement: Grok ACP Session SHALL provide the core Turn lifecycle

A Grok HarnessSession SHALL create or load one Grok Native Session, accept sequential text Turns, and map ACP message, thought, tool, permission, cancellation, and terminal signals into the existing ordered Host lifecycle without manufacturing native content.

#### Scenario: Grok completes a tool-using Turn
- **WHEN** ACP emits thought chunks, a tool call and updates, message chunks, and a successful Prompt response
- **THEN** the Session SHALL emit one ordered Turn with Reasoning, Tool, and Agent Message Item lifecycles completed before `turn.completed(succeeded)`

#### Scenario: Grok requests tool permission
- **WHEN** ACP sends `session/request_permission` for the active Turn
- **THEN** the Session SHALL expose a Host Approval containing only native-declared options
- **AND** one accepted Host action SHALL resolve only the matching ACP request

#### Scenario: User cancels Grok
- **WHEN** Host accepts `turn.cancel` for the active Turn
- **THEN** the Session SHALL send ACP `session/cancel`, close pending interactions, and wait for exactly one cancelled or failed native terminal

### Requirement: Grok configuration and Usage SHALL be capability-driven

GrokAdapter SHALL derive Model, Thinking/Effort, Permission Mode, and Usage support only from validated ACP initialization, Session configuration, and structured Grok metadata. Missing or malformed optional metadata MUST disable or omit that capability without failing an otherwise usable text Session.

#### Scenario: Grok advertises Models and Effort
- **WHEN** validated initialization and Session responses expose selectable Models and Thinking/Effort values
- **THEN** inspection SHALL return normalized opaque Model Refs and Thinking options
- **AND** only configuration options proven writable SHALL be declared selectable

#### Scenario: Grok reports reliable Usage
- **WHEN** the active or restored Session reports valid structured Token, context, cache, reasoning, or cost Usage
- **THEN** GrokAdapter SHALL publish the reliable fields through the existing `HostUsage` contract
- **AND** unknown values SHALL be omitted rather than estimated

### Requirement: Grok MVP SHALL fail closed for unsupported history and Diff operations

Grok Session resume SHALL use the Grok Native Session ID and structure-proven ACP replay or read-only Native history to construct `HostThreadSnapshot`. Grok MVP SHALL declare exact Fork, cross-cwd Fork, and rollback unsupported. It SHALL map edits as File Changes only when Grok supplies a valid Unified Diff.

#### Scenario: Existing Grok Thread is reopened
- **WHEN** Host resumes a mapped Grok Native Session
- **THEN** GrokAdapter SHALL load the same Session and return its available ordered history without persisting Transcript content in codexhost

#### Scenario: Desktop requests Fork or rollback
- **WHEN** a Grok Thread receives an exact Fork or rollback request during the MVP
- **THEN** Host SHALL return the existing explicit unsupported error
- **AND** the request SHALL NOT fall through to Codex or mutate the Grok Session

#### Scenario: Tool edit has no reliable Diff
- **WHEN** ACP reports an edit Tool without a valid Unified Diff
- **THEN** the Session SHALL expose it as Tool Execution rather than fabricate a File Change Item
