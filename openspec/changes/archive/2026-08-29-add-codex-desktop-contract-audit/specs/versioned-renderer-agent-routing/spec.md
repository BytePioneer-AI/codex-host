## ADDED Requirements

### Requirement: Versioned Renderer contracts SHALL expose sanitized audit inspection
The modules that own version-locked Composer Model targeting, request/prewarm ownership, title ownership, Settings insertion, Sidebar decoration, Usage/Credits placement, Permission control, and Fork discovery SHALL expose reusable read-only inspection that reports only normalized contract state. Adding audit inspection MUST NOT change production binding, routing, recovery timing, or fail-closed behavior.

#### Scenario: Audit inspects the active Composer
- **WHEN** a local audit requests the Composer and Model contract summary
- **THEN** the Renderer Extension SHALL apply the same supported identity, candidate uniqueness, and ownership rules used by production binding
- **AND** it SHALL return stable state and reason codes without returning the Composer target value, Thread identity, Model value, Fiber object, or rendered content

#### Scenario: Audit inspects request and title ownership
- **WHEN** a local audit requests request/prewarm or title contract status
- **THEN** Desktop Control SHALL apply the existing Host ownership and `webContents` ownership checks
- **AND** inspection SHALL not install, reload, or mutate those policies in read-only mode

#### Scenario: Audit support is absent from production entry
- **WHEN** the production Renderer entry installs codexhost binding
- **THEN** it SHALL continue using the existing production installation and status interfaces
- **AND** it SHALL NOT automatically execute or persist the local contract audit
