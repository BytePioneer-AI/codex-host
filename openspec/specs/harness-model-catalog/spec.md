# harness-model-catalog Specification

## Purpose
TBD - created by archiving change implement-pi-model-catalog-slice. Update Purpose after archive.
## Requirements
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

#### Scenario: Inspection cannot start Pi
- **WHEN** Pi is not installed, cannot start, or returns an invalid catalog
- **THEN** inspection returns an explicit normalized unavailable or error result
- **AND** no Native Session, background process, or user configuration change remains

#### Scenario: Inspection cannot start a Harness
- **WHEN** a registered Harness is not installed, cannot start, lacks required Model operations, or returns an invalid catalog
- **THEN** inspection returns an explicit normalized unavailable, ready-without-selection, or error result according to the proven capability
- **AND** no Native Session, background process, user configuration change, or failed cache entry remains

#### Scenario: Native catalog contains private fields
- **WHEN** native Model objects contain base URLs, prices, authentication data, account data, absolute paths, custom configuration, or unknown fields
- **THEN** those values do not enter the Harness Catalog, Host response, Renderer state, logs, or committed fixtures

### Requirement: Model references preserve exact Adapter-owned identity
A `HarnessModelRef` SHALL be opaque outside its owning Adapter, SHALL be stable for the same native Model identity, and SHALL distinguish every native Model the Harness can select.

#### Scenario: Two Providers expose the same Model ID
- **WHEN** Pi returns the same Model ID for two different Providers
- **THEN** PiAdapter emits two different Model Refs and labels that allow the user to distinguish the entries

#### Scenario: Native identity contains separators
- **WHEN** a Provider or Model ID contains `/`, `-`, `.`, or another valid native separator
- **THEN** PiAdapter round-trips the exact pair without separator replacement or guessed parsing

#### Scenario: Catalog contains exact duplicates
- **WHEN** Pi returns the same Provider and Model ID pair more than once
- **THEN** PiAdapter emits one entry for that pair and returns all entries in deterministic order

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

#### Scenario: Native readback differs from the request
- **WHEN** Pi accepts the write but `get_state` reports a different actual Model
- **THEN** PiAdapter publishes the actual state and returns an explicit failure rather than claiming the requested Model is effective

#### Scenario: Native readback cannot establish the requested selection
- **WHEN** the owning Adapter's setter rejects or native readback proves that the requested concrete selection was not accepted
- **THEN** the Adapter preserves the prior confirmed state and returns an explicit failure rather than claiming the requested Model is effective

#### Scenario: Native write outcome cannot be determined
- **WHEN** a Model write may have occurred and actual Model state cannot be read reliably
- **THEN** the Adapter faults the Session and rejects later writes or Turns

### Requirement: Host exposes only fixed Model control operations
Host Runtime SHALL handle fixed codexhost inspection and Pi Thread Model-selection methods, SHALL runtime-validate their params and results, and SHALL not expose a generic Harness or native RPC escape hatch.

#### Scenario: Renderer reads the Pi draft catalog
- **WHEN** the Renderer sends `codexhost/harness/inspect` for Pi
- **THEN** Host calls `HarnessAdapter.inspect` and returns the normalized inspection without opening a Thread Session

#### Scenario: Renderer selects an existing Pi Thread Model
- **WHEN** the Renderer sends `codexhost/thread/model/select` with a current-process Pi Thread ID and valid Model Ref while the Session is Idle
- **THEN** Host executes `model.select`, waits until the ordered state event is consumed, and returns the observed effective Model state

#### Scenario: Control references a Codex or unknown Thread
- **WHEN** a codexhost Model control method references a Thread not owned by the current Host Pi route
- **THEN** Host returns an explicit error and does not forward the custom method to the official Codex app-server

#### Scenario: Official request is unrelated
- **WHEN** a Codex-owned or unknown official app-server request does not use a codexhost control method or Pi resource
- **THEN** Host preserves the stock transparent forwarding path

### Requirement: Draft Model selection is bound to the exact Pi creation
The Renderer SHALL bind a selected Pi Model to the same logical Composer and native create state as the Pi Agent selection, without using a process-level or window-level next-Model value.

#### Scenario: Draft selects a Pi Model and submits
- **WHEN** a Pi draft selects a Model and is submitted
- **THEN** its `thread/start.model` carries a bounded internal Pi transport carrier containing that opaque Model Ref
- **AND** Host opens only that Pi Thread with the selected Model

#### Scenario: Pi draft uses the native default
- **WHEN** a Pi draft submits without an explicit Model Ref
- **THEN** the generic `codexhost/pi-native` carrier continues to route Pi and Pi Native Mode keeps its current Model

#### Scenario: Two Composer drafts select different Models
- **WHEN** two logical Composers select different Pi Models
- **THEN** each creation carries only its own Ref and neither request can consume the other Composer's state

### Requirement: Renderer displays an Agent-separated Pi Model control
For the supported Desktop build, the Renderer SHALL show a codexhost-owned Pi Model option control separately from the Agent control and SHALL display only normalized labels and confirmed selection state.

#### Scenario: User selects Pi
- **WHEN** a Composer changes its Agent to Pi and inspection succeeds
- **THEN** the Model control displays the Pi RPC catalog and selects the current/default Model Ref
- **AND** it never displays `codexhost/pi-native` or the selected transport carrier as a Model

#### Scenario: User keeps Codex
- **WHEN** the Composer Agent is Codex
- **THEN** codexhost does not inject Pi entries into the official Codex Model picker or modify the user's Codex Model configuration

#### Scenario: Catalog request becomes stale
- **WHEN** a prior catalog request resolves after the Composer changed Agent, target, request generation, or was disposed
- **THEN** the stale response is ignored and cannot overwrite the current control

#### Scenario: Existing selection fails
- **WHEN** immediate native selection for an existing Pi Thread fails
- **THEN** the prior confirmed Model remains selected and an explicit error state is shown

#### Scenario: Renderer ownership is ambiguous
- **WHEN** the supported request manager, Composer Model atom, or conversation Thread identity cannot be uniquely validated
- **THEN** Pi Model discovery or selection is disabled and no generic request or guessed identity fallback is used

### Requirement: Draft state and Existing Thread recovery have distinct sources
The Renderer SHALL keep unsubmitted draft Model state only in the logical Composer. An Existing Thread SHALL recover its confirmed current Model and Thinking state from the resumed Native Session Snapshot and SHALL NOT infer it from cached UI state or another Thread.

#### Scenario: Same-process Composer replacement or revisit
- **WHEN** an equivalent logical Pi Composer is replaced or revisited in the same Renderer process
- **THEN** its confirmed Pi Model Ref is restored with the existing Composer state

#### Scenario: New default Composer opens
- **WHEN** a conversation Composer is replaced by a new default Composer
- **THEN** the new Composer does not inherit the prior Pi Model Ref

#### Scenario: Application restarts
- **WHEN** Host restores an Existing external Thread after restart
- **THEN** Host resumes the mapped Native Session and initializes the Thread from the current state returned with its Snapshot
- **AND** Mapping Store and cached Renderer state do not become a second source of Model or Thinking truth

### Requirement: Selectable Model aliases remain distinct from resolved Models
An Adapter SHALL preserve every distinct native selectable value as an Adapter-owned Model Ref even when multiple values currently resolve to the same underlying Model. A dynamic default or family alias SHALL NOT be replaced by a resolved Model string that cannot reproduce the same policy selection.

#### Scenario: Several Claude aliases resolve to one custom Model
- **WHEN** Claude Code reports distinct `default`, family alias, and concrete selectable values that currently resolve to one custom Model
- **THEN** Claude Adapter returns distinct Refs with distinguishable labels and may repeat the same `resolvedModelLabel`
- **AND** Host and Renderer do not deduplicate those Refs by display name or resolved label

#### Scenario: Default policy changes its resolved Model
- **WHEN** the same default Ref resolves to a different actual Model after refresh or Session initialization
- **THEN** the default Ref remains stable while the resolved Model label is refreshed from native readback
