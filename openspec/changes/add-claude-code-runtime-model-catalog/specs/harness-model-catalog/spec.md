## MODIFIED Requirements

### Requirement: Harness inspection returns a normalized Model Catalog without creating a Session
The `HarnessAdapter` SHALL provide side-effect-free Model inspection that returns browser-safe normalized Models, optional runtime-resolved Model labels, and structural Model-selection capability without exposing native protocol objects or creating a persistent Native Session. Inspection SHALL own and close every temporary runtime resource before resolving.

#### Scenario: Pi inspection succeeds
- **WHEN** a caller inspects Pi with an optional cwd
- **THEN** the Adapter returns ready status, a deterministic Model Catalog, the current native Model as the default Ref, and `configuration.selectModel: true`
- **AND** every temporary Pi process is closed before inspection resolves

#### Scenario: Claude inspection succeeds
- **WHEN** a caller inspects Claude Code and its official SDK returns a valid initialization Model list plus stable current-Model readback without a Prompt
- **THEN** the Adapter returns a deterministic Catalog of the current Claude Code configuration's selectable values, a default selectable Ref, the observed resolved Model label, and `configuration.selectModel: true`
- **AND** no model Turn or persistent Native Session is created and every temporary Claude process is closed before inspection resolves

#### Scenario: Inspection cannot start a Harness
- **WHEN** a registered Harness is not installed, cannot start, lacks required Model operations, or returns an invalid catalog
- **THEN** inspection returns an explicit normalized unavailable, ready-without-selection, or error result according to the proven capability
- **AND** no Native Session, background process, user configuration change, or failed cache entry remains

#### Scenario: Native catalog contains private fields
- **WHEN** native Model objects contain base URLs, prices, authentication data, account data, absolute paths, custom configuration, or unknown fields
- **THEN** those values do not enter the Harness Catalog, Host response, Renderer state, logs, or committed fixtures

### Requirement: Session effective Model uses the ordered state stream
A Harness Session SHALL expose structural Model-selection capability, an optional replayable `effectiveModel`, and an optional display-only `resolvedModelLabel` in its complete Session state. After `open()` resolves, effective or resolved Model changes SHALL be published only through ordered `session.state.changed` events.

#### Scenario: First Pi Turn starts with a requested Model
- **WHEN** a lazy Pi Session was opened with a Model Ref and receives its first accepted Turn
- **THEN** PiAdapter starts Pi, applies the requested native Model if needed, reads native state, and emits the confirmed effective Model before `turn.started`

#### Scenario: First Claude Turn starts with a requested alias
- **WHEN** a lazy Claude Session was opened with a selectable alias Ref and receives its first accepted Turn
- **THEN** Claude Adapter initializes the Query with that selection and emits the accepted selectable Ref plus stable runtime-resolved Model label before `turn.started`

#### Scenario: Command result is observed
- **WHEN** `model.select` succeeds
- **THEN** its result only reports `{completed: true}`
- **AND** callers derive the effective and resolved Model state from the complete state event that was enqueued before the result resolved

### Requirement: Model selection is serialized and Idle-only
A Session SHALL accept `model.select` only while open and Idle, SHALL serialize it against Turn acceptance and other configuration writes, and SHALL preserve exactly one actual effective state. An Adapter MAY accept a dynamic alias whose resolved native Model differs from its selectable value, but it MUST publish the replayable Ref and valid native readback as distinct fields.

#### Scenario: Idle Pi Session selects another Model
- **WHEN** an already-started idle Pi Session receives a valid different Model Ref
- **THEN** PiAdapter calls the native Model setter, reads native state, emits one complete confirmed state, and then completes the command

#### Scenario: Idle Claude Session selects a dynamic alias
- **WHEN** an already-started idle Claude Session receives a valid alias Ref and the SDK setter plus stable actual-Model readback succeed
- **THEN** Claude Adapter emits that alias as `effectiveModel`, emits the readback as `resolvedModelLabel`, and then completes the command even when the two native strings differ

#### Scenario: Selection races with an active Turn
- **WHEN** `model.select` is requested while a Turn is being accepted, active, cancelling, or settling
- **THEN** the Session rejects it with `sessionBusy` or `invalidState`
- **AND** no native Model write occurs

#### Scenario: Turn races with selection
- **WHEN** `turn.start` is requested while Model selection is pending
- **THEN** the Session rejects the Turn as busy or accepts it only after the selection has fully completed
- **AND** the Model write and Agent Loop do not overlap

#### Scenario: Native readback cannot establish the requested selection
- **WHEN** the owning Adapter's setter rejects or native readback proves that the requested concrete selection was not accepted
- **THEN** the Adapter preserves the prior confirmed state and returns an explicit failure rather than claiming the requested Model is effective

#### Scenario: Native write outcome cannot be determined
- **WHEN** a Model write may have occurred and actual Model state cannot be read reliably
- **THEN** the Adapter faults the Session and rejects later writes or Turns

## ADDED Requirements

### Requirement: Selectable Model aliases remain distinct from resolved Models
An Adapter SHALL preserve every distinct native selectable value as an Adapter-owned Model Ref even when multiple values currently resolve to the same underlying Model. A dynamic default or family alias SHALL NOT be replaced by a resolved Model string that cannot reproduce the same policy selection.

#### Scenario: Several Claude aliases resolve to one custom Model
- **WHEN** Claude Code reports distinct `default`, family alias, and concrete selectable values that currently resolve to one custom Model
- **THEN** Claude Adapter returns distinct Refs with distinguishable labels and may repeat the same `resolvedModelLabel`
- **AND** Host and Renderer do not deduplicate those Refs by display name or resolved label

#### Scenario: Default policy changes its resolved Model
- **WHEN** the same default Ref resolves to a different actual Model after refresh or Session initialization
- **THEN** the default Ref remains stable while the resolved Model label is refreshed from native readback
