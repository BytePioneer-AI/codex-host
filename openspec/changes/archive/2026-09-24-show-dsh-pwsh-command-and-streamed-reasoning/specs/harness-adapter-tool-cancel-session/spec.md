## ADDED Requirements

### Requirement: Recoverable native shell commands use the Command Execution carrier

Protocol Core SHALL project a Generic Tool with a recognized shell name and a non-empty native command argument as a `commandExecution` Item, preserving the actual command and available bounded output. Recognition MUST include DSH `pwsh`; a missing or invalid command MUST remain a Generic Tool.

#### Scenario: DSH PowerShell command is projected

- **WHEN** a DSH `pwsh` Tool starts with a non-empty `command` argument and later produces text output
- **THEN** the originating Codex Thread SHALL receive an expandable `commandExecution` Item containing that command and available output
- **AND** its Item identity and completion SHALL remain correlated with the original Tool

#### Scenario: Shell Tool has no usable command

- **WHEN** a recognized shell Tool has no non-empty command argument
- **THEN** Protocol Core SHALL keep the Generic Tool projection and SHALL NOT invent a command
