## ADDED Requirements

### Requirement: Recoverable Renderer installation failures SHALL NOT be compatibility guidance
Launcher compatibility guidance SHALL NOT present Title Policy structure failure, Agent routing structure failure, Draft routing structure failure, or unclassified inspection failure as a user-visible compatibility issue. Those failures MUST NOT trigger the compatibility-specific update path or an automatic switch to stock Codex.

#### Scenario: Controller is recovering a critical Renderer capability
- **WHEN** the current Controller cannot complete Title, Agent, Draft, or inspection installation and remains alive for retry
- **THEN** Launcher SHALL continue managed codexhost startup without a compatibility dialog
- **AND** SHALL NOT invoke a compatibility-triggered update check for that condition

#### Scenario: Initial Renderer installation succeeds with an unreviewed title identity
- **WHEN** the complete initial installation succeeds and reports only `unreviewed-title-service-identity`
- **THEN** the existing non-blocking compatibility warning behavior SHALL remain available
- **AND** the warning SHALL NOT prevent managed startup

### Requirement: Production readiness SHALL omit removed blocking outcomes
The coherent production Controller payload SHALL NOT serialize `incompatible` or `detection-failed` readiness and SHALL NOT emit `title-isolation-structure-unavailable`, `agent-routing-structure-unavailable`, `draft-routing-structure-unavailable`, or `inspection-failed` issues.

#### Scenario: Initial installation throws a classified structure error
- **WHEN** a `RendererCompatibilityError` reaches production Controller lifecycle handling
- **THEN** the error SHALL become internal recovery state rather than a readiness issue
- **AND** the first production readiness line SHALL contain no removed capability or reason
