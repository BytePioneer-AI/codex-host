## ADDED Requirements

### Requirement: Installed Remote Hosts SHALL expose explicit lifecycle management
On macOS and Linux, `codexhost remote start`, `stop`, and `status` SHALL manage and inspect the installed Remote Host without launching a graphical Desktop. Lifecycle operations MUST use the installation manifest as the source of executable and data paths.

#### Scenario: Start replaces a conflicting installed stock listener
- **GIVEN** the target control socket is owned by the current user's stock Codex executable recorded in the installation manifest
- **AND** that process is running `app-server --listen unix://`
- **WHEN** the user runs `codexhost remote start`
- **THEN** codexhost terminates that conflicting listener and its launcher process tree
- **AND** starts the managed codexhost Remote Host
- **AND** returns success only after the control socket is ready

#### Scenario: Start encounters an unknown socket owner
- **WHEN** the target control socket is active but its owner cannot be verified as either the installed codexhost Remote Host or the recorded stock Codex listener
- **THEN** `codexhost remote start` fails without terminating the owner or unlinking the socket

#### Scenario: Start is repeated
- **GIVEN** the installed codexhost Remote Host already owns the control socket
- **WHEN** the user runs `codexhost remote start`
- **THEN** the command returns success without starting a duplicate listener

#### Scenario: Stop targets the managed Remote Host
- **GIVEN** the installed codexhost Remote Host owns the control socket
- **WHEN** the user runs `codexhost remote stop`
- **THEN** codexhost terminates that listener and waits for the socket to close
- **AND** it does not terminate unrelated Codex processes

#### Scenario: Status recognizes the managed Desktop SSH WebSocket transport
- **GIVEN** the installed codexhost Remote Host owns the control socket through its Desktop SSH WebSocket transport
- **WHEN** the user runs `codexhost remote status`
- **THEN** status probes the Unix WebSocket directly
- **AND** reports the runtime as codexhost running without requiring stock Codex proxy transport

#### Scenario: Status reports installation and runtime state
- **WHEN** the user runs `codexhost remote status`
- **THEN** the response preserves installation integrity diagnostics
- **AND** reports the runtime as stopped, running, conflict, or unknown
- **AND** identifies whether the active socket serves codexhost or stock Codex when that can be verified

#### Scenario: Lifecycle command runs without an installation
- **WHEN** the user runs `codexhost remote start` or `stop` before remote installation
- **THEN** the command fails without modifying processes or socket files
