## MODIFIED Requirements

### Requirement: Development configuration can enable registered Claude routing
The versioned Renderer Agent control SHALL use an explicit enabled-Agent list. A controlled or production configuration that includes Claude Code SHALL use the same Composer state machine and SHALL support an optional Composer-scoped Claude Model Ref without introducing another request hook or bypassing submit freeze and prewarm invalidation.

#### Scenario: Renderer configuration excludes Claude
- **WHEN** Claude Code is absent from the explicit enabled-Agent list
- **THEN** the Agent control omits Claude Code
- **AND** existing Pi transport selection and Codex restoration remain unchanged

#### Scenario: Renderer configuration enables Claude
- **WHEN** the validated enabled-Agent list includes Claude Code
- **THEN** the same Agent control adds a `Claude Code` option
- **AND** selecting it uses the same draft switch, prewarm clear, submit freeze, replacement transfer, and revisit restoration logic

#### Scenario: Claude create uses native default
- **WHEN** a locked Claude Composer without an explicit selected Ref creates a Thread on a supported Renderer build
- **THEN** the optimistic Model atom carries `codexhost/claude-code-native`
- **AND** no shared request object or official persistent Model default is modified

#### Scenario: Claude create uses selected Model
- **WHEN** a locked Claude Composer has one validated Claude Model Ref before creation
- **THEN** the optimistic Model atom carries the bounded Claude transport carrier containing that exact Ref
- **AND** the user sees the normalized Catalog label rather than the carrier or opaque Ref

#### Scenario: Disabled Agent is requested
- **WHEN** code attempts to select an Agent absent from the enabled list
- **THEN** Renderer rejects the switch and remains on the prior Agent

## ADDED Requirements

### Requirement: Renderer Model control is capability-driven for external Harnesses
For a supported Desktop build, Renderer SHALL use the fixed Harness inspection and Thread Model-selection methods for the currently selected external Harness when its inspection/session capability allows Model selection. It SHALL keep each Harness's Catalog and Model Ref opaque and MUST NOT branch on Claude or Pi native Model structure.

#### Scenario: User selects Claude Code
- **WHEN** a Claude Composer requests inspection and Claude returns a ready selectable Catalog
- **THEN** the existing codexhost Model control displays normalized Claude labels, selects the default Ref, and may display the bounded resolved Model label
- **AND** it does not show a Claude Thinking selector while `selectThinkingOption=false`

#### Scenario: User selects Pi after Claude
- **WHEN** the same draft changes from Claude Code to Pi
- **THEN** Renderer invalidates the Claude request generation and loads or restores only that Composer's Pi Catalog and selection
- **AND** a late Claude inspection cannot overwrite Pi state

#### Scenario: User returns to Codex
- **WHEN** an external Composer changes to Codex before submission
- **THEN** Renderer hides the codexhost Model control and restores the captured opaque official Model state
- **AND** it does not write any external selection through the official persistent Model setter

#### Scenario: External inspection is unavailable
- **WHEN** the fixed request manager is absent, inspection fails, or the returned Catalog is malformed
- **THEN** the affected external Model control fails closed and submission requiring unresolved configuration is blocked
- **AND** no generic request bridge or guessed Model list is used

### Requirement: Claude Model state follows the logical Composer lifecycle
Renderer SHALL scope selected Claude Model Ref, resolved Model display, Catalog, and asynchronous request generation to the same logical Composer identity used for Agent routing. Draft creation SHALL use the request-local carrier, while an existing Claude Thread SHALL change Model only through its validated Host Thread identity and confirmed Session state.

#### Scenario: Claude draft replacement retains Model
- **WHEN** a Claude draft transitions from the default target to its created conversation target
- **THEN** the replacement retains the selected Claude Ref and locked Agent state for that exact create

#### Scenario: New task resets Claude Model
- **WHEN** a Claude conversation transitions to a new default Composer
- **THEN** the new Composer may inherit the most recently submitted Agent but does not inherit the prior Thread's Claude Model Ref

#### Scenario: Existing Claude Thread selects an alias
- **WHEN** a validated current-process Claude Thread selects another Catalog Ref while Idle
- **THEN** Renderer sends the fixed Thread Model-selection request and applies only Host-confirmed `effectiveModel` and `resolvedModelLabel`

#### Scenario: Claude selection fails
- **WHEN** Host rejects Model selection or the Session faults before confirmed state
- **THEN** Renderer keeps the prior confirmed selection when still valid, shows an explicit unavailable state, and does not rewrite the carrier to the requested Ref

#### Scenario: Claude result becomes stale
- **WHEN** an inspection or selection resolves after Agent, Composer, target, request generation, or extension lifetime changed
- **THEN** Renderer ignores the result and preserves the newer state
