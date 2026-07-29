## MODIFIED Requirements

### Requirement: Versioned Adapter drives the native create Model state
For a supported Desktop build, the Renderer Adapter SHALL synchronously update the uniquely associated Composer's optimistic native Model state to a bounded internal Pi transport carrier only when that Composer selects Pi. The generic carrier SHALL be `codexhost/pi-native`; an explicit selected Pi Model SHALL be represented by the same carrier plus an opaque Harness Model Ref and SHALL remain internal rather than user-visible.

#### Scenario: Pi conversation create
- **WHEN** a supported Adapter observes the unique Pi Composer without an explicit Pi Model Ref before native creation
- **THEN** the native conversation `thread/start` carries `codexhost/pi-native` as its internal Model transport token

#### Scenario: Pi conversation create with selected Model
- **WHEN** a supported Pi Composer has selected a valid Pi Model Ref before native creation
- **THEN** the native conversation `thread/start` carries the bounded selected Pi transport carrier for that exact Composer
- **AND** the displayed Model remains the normalized Pi catalog label rather than the carrier

#### Scenario: Codex conversation create
- **WHEN** the Composer selects Codex
- **THEN** the Adapter restores the captured opaque official state and the native create retains official Model behavior

#### Scenario: Unsupported or ambiguous Renderer
- **WHEN** the asset, atom pair, Model target, installation timing, or Composer association is unsupported or ambiguous
- **THEN** Pi creation is blocked with an explicit unavailable state and no request is silently routed to Codex

#### Scenario: Official prewarm bridge is unavailable
- **WHEN** the version-locked Adapter cannot uniquely recover the owned official request bridge or its signature is unsupported
- **THEN** draft Agent switching is unavailable and no generic Desktop request capability is exposed to the Renderer Extension

#### Scenario: Model control request manager is unavailable
- **WHEN** Agent routing remains supported but the Adapter cannot uniquely recover the active request manager needed for fixed Model controls
- **THEN** Pi Model inspection and immediate selection are unavailable
- **AND** the Adapter does not expose or call a generic request method

#### Scenario: Transport state is temporary
- **WHEN** Pi is selected and later a new Codex Composer is mounted
- **THEN** the Adapter restores the opaque pre-Pi state without calling the official persistent Model setter or persisting any Pi transport carrier as the user default Model

## ADDED Requirements

### Requirement: Pi Model state follows the logical Composer lifecycle
The Renderer SHALL keep the selected Pi Model Ref and asynchronous Model-control state scoped to the same logical Composer identity used for Agent routing while allowing Model selection for an existing Pi Thread only through its validated current-process Thread identity.

#### Scenario: Draft replacement retains Model
- **WHEN** a Pi draft or locked new-Thread Composer transitions from its opaque default target to the created conversation target
- **THEN** the replacement retains the selected Pi Model Ref and control state

#### Scenario: Same-process conversation revisit
- **WHEN** an equivalent opaque conversation target is revisited in the same Renderer process
- **THEN** the Renderer restores the final Pi Model Ref without persisting or logging the Thread identity

#### Scenario: New task resets Model
- **WHEN** a conversation target transitions to a new default Composer
- **THEN** the new Composer starts as Codex without the prior Pi Model Ref

#### Scenario: Existing Pi Thread selection
- **WHEN** the supported conversation target yields one validated current-process Host Thread ID and the user selects a different Pi Model
- **THEN** Renderer sends the fixed Thread Model-selection request and applies only the confirmed effective Ref returned from Host state observation

#### Scenario: Stale asynchronous result
- **WHEN** an earlier inspection or selection resolves after the logical Composer, Agent, target, or request generation changed
- **THEN** Renderer ignores that result and preserves the newer state
