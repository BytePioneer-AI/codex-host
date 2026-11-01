## ADDED Requirements

### Requirement: Packaged Remote Host SHALL support native ARM64 Linux
The npm distribution SHALL provide the same managed Remote Host installation, lifecycle, Unix socket transport, Harness execution, and reversible uninstall behavior on native ARM64 Linux as on x64 Linux.

#### Scenario: ARM64 SSH host installs codexhost
- **GIVEN** an ARM64 Linux SSH host has supported Node.js and an official ARM64 Codex CLI
- **WHEN** the user installs `@codexhost/cli` and runs `codexhost remote install` followed by `codexhost remote start`
- **THEN** the managed entrypoint uses ARM64 codexhost Launcher and Shim binaries
- **AND** the Remote Host accepts the existing Codex WebSocket-over-Unix-socket transport
- **AND** Harness processes remain local to the ARM64 SSH host
