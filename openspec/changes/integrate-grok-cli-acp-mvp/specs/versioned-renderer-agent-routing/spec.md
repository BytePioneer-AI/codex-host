## ADDED Requirements

### Requirement: Production Renderer SHALL expose Grok as an external Agent

The supported Renderer Agent control SHALL include Grok when production configuration enables it. Grok SHALL use the existing Composer draft switch, prewarm clear, submit freeze, immutable Thread ownership, and availability behavior used by other external Harnesses.

#### Scenario: User selects Grok for a new Thread
- **WHEN** Grok inspection is ready and the user selects Grok before submission
- **THEN** the Composer SHALL carry `codexhost/grok-native` or its bounded selected configuration for that exact create
- **AND** the Agent SHALL freeze as Grok when submitted

#### Scenario: Grok is not installed or unavailable
- **WHEN** Grok inspection reports not installed, authentication required, unavailable, or error
- **THEN** the Grok option SHALL remain visibly unavailable with the configured install/help action
- **AND** existing Codex, Pi, and Claude Code selection SHALL remain unchanged

### Requirement: Renderer SHALL reuse capability-driven external controls for Grok

Renderer SHALL display Grok Model, Thinking, Permission, Usage, and Thread controls only from normalized Host inspection and Thread state. It MUST NOT parse ACP, Grok `_meta`, Native Session files, or `x.ai/*` payloads.

#### Scenario: Grok advertises Model and Thinking selection
- **WHEN** Host returns a ready Grok Catalog with selectable Model and Thinking capabilities
- **THEN** Renderer SHALL use the existing external controls and keep Grok preferences isolated from Pi and Claude Code

#### Scenario: Grok history operation is unsupported
- **WHEN** Host reports Grok Fork or rollback capability as false
- **THEN** Renderer SHALL preserve the existing capability-driven unsupported behavior
- **AND** it SHALL NOT add a Grok-specific Fork, rollback, or Slash Command control
