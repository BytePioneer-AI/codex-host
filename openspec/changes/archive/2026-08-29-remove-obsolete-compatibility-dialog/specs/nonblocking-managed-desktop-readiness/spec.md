## ADDED Requirements

### Requirement: Non-blocking recovery SHALL NOT expose a compatibility-dialog control path
The production Launcher, Controller attachment protocol, Renderer Control Session, and Renderer binding SHALL NOT expose a compatibility-dialog-specific warning acknowledgement or update command. Removing that path MUST NOT remove the normal Settings update operations or runtime Renderer recovery.

#### Scenario: Controlled instance attachment protocol is used
- **WHEN** a Launcher attaches to an existing controlled Desktop
- **THEN** the authenticated Controller protocol SHALL support bounded Desktop activation
- **AND** SHALL NOT accept a compatibility-dialog-specific update request

#### Scenario: User checks for updates in Settings
- **WHEN** the Renderer Settings update page invokes the fixed update operations
- **THEN** Host update check, start, and status operations SHALL remain available
- **AND** their behavior SHALL NOT depend on a Launcher compatibility dialog

#### Scenario: Renderer integration is unavailable
- **WHEN** Title, Agent, Draft, or inspection installation fails
- **THEN** Controller SHALL retain background recovery and official Codex fallback
- **AND** SHALL NOT display, request, or persist a compatibility warning acknowledgement
