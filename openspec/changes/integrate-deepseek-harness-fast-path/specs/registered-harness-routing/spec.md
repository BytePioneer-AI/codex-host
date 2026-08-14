## ADDED Requirements

### Requirement: DeepSeek Harness is a finite registered external Harness
Protocol Core and Host Runtime SHALL recognize `deepseek-harness` and its `codexhost/deepseek-harness-native` transport Model as a registered external Harness without changing official Codex, Pi, or Claude Code routing.

#### Scenario: DeepSeek transport Model is decoded
- **WHEN** `thread/start.model` carries the DeepSeek Harness transport Model
- **THEN** Protocol Core SHALL route creation to external Harness `deepseek-harness`

#### Scenario: DeepSeek Adapter is unavailable
- **WHEN** a DeepSeek create reaches a Host whose runtime inspection reports unavailable
- **THEN** Host SHALL return the existing explicit external Harness error
- **AND** SHALL NOT forward the request to official Codex

### Requirement: Host composition registers the DeepSeek Adapter
The Host composition root SHALL construct the DeepSeek Adapter with its explicit runtime command environment and manage it through the same Adapter registry used by Pi and Claude Code.

#### Scenario: Host closes mixed external Adapters
- **WHEN** Host shuts down with DeepSeek and other external Sessions
- **THEN** it SHALL close them through the shared HarnessAdapter lifecycle without a DSH-specific Thread path
