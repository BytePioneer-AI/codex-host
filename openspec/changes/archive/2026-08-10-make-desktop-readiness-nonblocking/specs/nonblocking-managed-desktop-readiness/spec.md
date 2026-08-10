## ADDED Requirements

### Requirement: Managed Desktop startup SHALL survive Renderer capability unavailability
The Desktop Controller SHALL treat initial Title Policy, Agent routing, Draft routing, and unclassified Renderer inspection failures as recoverable internal installation states. It MUST NOT emit those failures as blocking compatibility readiness, exit solely because of them, or cause the Launcher to show a compatibility-boundary dialog.

#### Scenario: Initial Agent routing structure is unavailable
- **WHEN** the initial Renderer installation cannot bind a supported Composer Model controller or Agent routing target
- **THEN** the Controller SHALL keep the managed process chain running and publish non-blocking managed readiness
- **AND** the Launcher SHALL enter codexhost without displaying `agent-routing-structure-unavailable`

#### Scenario: Initial Draft routing structure is unavailable
- **WHEN** the initial Renderer installation cannot install the owned Draft Prewarm Policy
- **THEN** the Controller SHALL retain that failure only as a recoverable installation state
- **AND** the Launcher SHALL enter codexhost without displaying `draft-routing-structure-unavailable`

#### Scenario: Initial title structure is unavailable
- **WHEN** the initial Renderer installation cannot establish Title Policy ownership
- **THEN** the Controller SHALL retain that failure only as a recoverable installation state
- **AND** the Launcher SHALL enter codexhost without displaying `title-isolation-structure-unavailable`

#### Scenario: Initial inspection process fails
- **WHEN** Renderer Bundle reading, Inspector execution, or another installation operation fails before a Session is available
- **THEN** the Controller SHALL retain that failure only as a recoverable installation state
- **AND** the Launcher SHALL enter codexhost without displaying `compatibility-detection` or `inspection-failed`

### Requirement: Controller SHALL recover Renderer integration in the background
The Controller SHALL serialize complete Session installation and use. While no valid Session exists, it SHALL retry installation with bounded exponential backoff from 30 seconds to 5 minutes. After a Session becomes ready it SHALL reset that backoff and use the existing reload recovery operation; a later readiness failure SHALL close and clear that Session and return to installation retry without terminating the managed Desktop.

#### Scenario: User logs in after managed startup
- **WHEN** initial installation fails because the logged-out Renderer has no supported Composer Model state and the user later reaches a supported Composer
- **THEN** a subsequent Controller retry SHALL install the complete Renderer Session
- **AND** external controls SHALL become available only after existing local prerequisites report ready

#### Scenario: Ready Session loses its Renderer binding
- **WHEN** `ensureInstalled()` fails after a Session previously became ready
- **THEN** the Controller SHALL close and clear the failed Session and continue running
- **AND** it SHALL retry complete installation without producing a blocking compatibility result

### Requirement: Controller attachment SHALL remain bounded during recovery
The Controller SHALL start its authenticated loopback attachment server even when no Renderer Session is currently available. Attach, compatibility-update, and shutdown operations SHALL remain serialized and MUST NOT claim success unless the required Session operation completes.

#### Scenario: Attach arrives while installation is unavailable
- **WHEN** a valid attachment request arrives while the Controller has no Session
- **THEN** the Controller SHALL make one serialized bounded installation attempt
- **AND** it SHALL activate the Desktop only after installation succeeds or return the existing bounded failure response

### Requirement: Official Codex fallback SHALL remain available without external readiness
A managed Host request without a valid external transport carrier SHALL continue to route to official Codex while Renderer integration is unavailable. The system MUST NOT synthesize an external carrier or infer a Harness from the configured default Agent.

#### Scenario: User submits through an unmodified official Composer
- **WHEN** Renderer integration is unavailable and Desktop emits a request without an external transport carrier
- **THEN** Host SHALL route the request to official Codex
- **AND** MUST NOT create a Pi or Claude Code Native Session
