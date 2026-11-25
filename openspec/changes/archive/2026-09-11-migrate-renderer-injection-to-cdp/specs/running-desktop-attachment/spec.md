## MODIFIED Requirements

### Requirement: Launcher coordinates controlled and official Desktop instances
The production Launcher SHALL distinguish stale-launcher recovery, clean Desktop launch, controlled-instance reuse, and an independently started official Desktop.

#### Scenario: Stale launcher state
- **WHEN** launcher state exists but its Desktop and control endpoint are both absent
- **THEN** Launcher MUST remove only the validated stale state and retry startup

#### Scenario: No Desktop is running
- **WHEN** no target Codex Desktop process exists
- **THEN** Launcher MUST use the existing clean launch with Shim, Host configuration, temporary loopback Chromium Renderer CDP, Renderer, and Controller supervision

#### Scenario: Independently started official Desktop is running
- **WHEN** a target Codex Desktop root exists without a live codexhost owner and authenticated Controller
- **THEN** Launcher MUST instruct the user to fully quit Codex before starting codexhost
- **AND** it MUST NOT inject, restart, or terminate that Desktop
