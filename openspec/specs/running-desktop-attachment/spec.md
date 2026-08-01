# running-desktop-attachment Specification

## Purpose
Define codexhost Desktop instance coordination: clean controlled launch, nonce-authenticated reuse, stale ownership recovery, explicit preservation of independently started official instances, and ownership-scoped cleanup.
## Requirements
### Requirement: Launcher coordinates controlled and official Desktop instances
The production Launcher SHALL distinguish stale-launcher recovery, clean Desktop launch, controlled-instance reuse, and an independently started official Desktop.

#### Scenario: Stale launcher state
- **WHEN** launcher state exists but its Desktop and control endpoint are both absent
- **THEN** Launcher MUST remove only the validated stale state and retry startup

#### Scenario: No Desktop is running
- **WHEN** no target Codex Desktop process exists
- **THEN** Launcher MUST use the existing clean launch with Shim, Host configuration, temporary Inspector, Renderer, and Controller supervision

#### Scenario: Independently started official Desktop is running
- **WHEN** a target Codex Desktop root exists without a live codexhost owner and authenticated Controller
- **THEN** Launcher MUST instruct the user to fully quit Codex before starting codexhost
- **AND** it MUST NOT inject, restart, or terminate that Desktop

### Requirement: Controlled Desktop attachment reuses the owning Controller
A second Launcher for an existing codexhost-controlled Desktop SHALL rely on the per-user ownership lock and a nonce-authenticated Controller handshake. It MUST NOT repeat Inspector, Desktop PID, or Shim/Host process-tree validation already completed before the owning Launcher published its descriptor, and it MUST NOT install a competing Controller.

#### Scenario: Healthy controlled instance
- **WHEN** another Launcher owns the lock and the descriptor's Controller returns `ready` for the exact nonce
- **THEN** the Controller MUST ensure the Renderer remains installed, activate its own Desktop window, and let the second Launcher return success without creating another Desktop or Host

#### Scenario: Controller handshake is unavailable or rejected
- **WHEN** the descriptor is absent, the endpoint is unavailable, the nonce is rejected, or Controller activation fails
- **THEN** Launcher MUST NOT treat the Desktop as a controlled reusable instance

### Requirement: Independently started official Desktop remains unmanaged
Launcher SHALL NOT attempt second-activation Inspector/CDP bootstrap or app-server rebinding for an independently started official Desktop on any platform.

#### Scenario: Official Desktop blocks clean launch
- **WHEN** the official Desktop is already running outside codexhost
- **THEN** Launcher MUST return a concrete full-quit instruction immediately
- **AND** it MUST leave the existing Desktop and its app-server unchanged

### Requirement: Runtime attachment state is minimal and recoverable
Launcher SHALL persist only the minimum per-user runtime descriptor needed to validate a controlled instance, using atomic replacement and restrictive local access where supported. Runtime state MUST NOT contain Prompt, Transcript, credentials, Thread IDs, project paths, or arbitrary environment data.

#### Scenario: Controlled launch publishes state
- **WHEN** a clean Desktop, Controller, Renderer, and Shim/Host chain become ready
- **THEN** Launcher MUST atomically publish only the Launcher owner PID, Controller port, and attachment nonce

#### Scenario: Controlled Desktop exits
- **WHEN** the owning Desktop and Controller shut down
- **THEN** Launcher MUST remove its matching runtime descriptor without deleting a newer instance's state

### Requirement: Runtime cleanup follows ownership
Launcher SHALL clean only the controlled Desktop resources and runtime descriptor owned by its clean launch. It MUST NOT automatically kill a Desktop that existed before the launch attempt.

#### Scenario: User closes a controlled Desktop
- **WHEN** the owning controlled Desktop exits
- **THEN** its Launcher, Controller, and matching runtime descriptor MUST stop or be removed within a bounded time

### Requirement: Real Windows evidence covers instance coordination
The change SHALL record real Windows user behavior without persisting PIDs, ports, command lines, environment, or user data.

#### Scenario: Instance coordination matrix
- **WHEN** validation covers official-first launch, clean codexhost launch, controlled repeat/double launch, official reactivation, stale recovery, and user quit
- **THEN** it MUST record controlled reuse separately from the explicit full-quit behavior for an independently started official Desktop
