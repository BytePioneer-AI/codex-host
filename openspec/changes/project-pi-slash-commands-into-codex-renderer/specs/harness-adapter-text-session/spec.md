## MODIFIED Requirements

### Requirement: Host uses a UI-independent text Session interface
The system SHALL expose a `HarnessAdapter` that opens a create, resume, or supported fork-mode `HarnessSession`. The Session SHALL accept typed Host commands, expose Host-semantic outputs, and provide read-only command discovery through the finite HarnessAdapter contract without exposing Pi RPC, Claude Agent SDK, Codex app-server, or Renderer-private types.

#### Scenario: Host creates a Pi Session
- **WHEN** Host routing selects Pi for a new Thread
- **THEN** the Host SHALL open a create-mode Session through the `HarnessAdapter` interface
- **AND** the Host SHALL NOT construct or invoke `PiRpcSession` directly

#### Scenario: Host discovers Session commands
- **WHEN** Host needs the commands available in an opened external Thread
- **THEN** it SHALL call `HarnessSession.getCommandCatalog()` through the owning Adapter contract
- **AND** it SHALL NOT inspect Harness-native command payloads

#### Scenario: Public Session boundary remains finite
- **WHEN** command discovery is added to the production Session interface
- **THEN** the interface SHALL NOT add `executeSlashCommand`, `executeNative`, a generic method/payload request, or a Renderer control
- **AND** command execution SHALL continue through existing typed Host commands and ordered outputs
