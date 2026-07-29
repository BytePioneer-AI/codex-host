## ADDED Requirements

### Requirement: Composer Agent locks before native creation

The Renderer Extension SHALL keep Agent state isolated by logical Composer and SHALL lock the selected Agent during the first input that can trigger native Thread creation.

#### Scenario: Pi is selected before input

- **WHEN** a user selects Pi in an empty new-Thread Composer and begins input
- **THEN** the Composer Agent is locked to Pi before any related conversation `thread/start`

#### Scenario: First creation replaces the Composer DOM

- **WHEN** a locked new-Thread Composer transitions from its opaque `default` Model target to a `conversation` target
- **THEN** the replacement Composer retains the same Pi selection and locked phase

#### Scenario: User opens a new Thread

- **WHEN** a conversation Composer is replaced by a new default Composer
- **THEN** the new Composer starts as Codex and draft rather than inheriting the previous Thread Agent

#### Scenario: User attempts to switch after input

- **WHEN** a Composer Agent is locked
- **THEN** the Agent controls are disabled and selecting another Agent requires a new Thread

### Requirement: Versioned Adapter drives the native create Model state

For a supported Desktop build, the Renderer Adapter SHALL synchronously update the uniquely associated Composer's optimistic native Model state to `codexhost/pi-native` only when that Composer selects Pi.

#### Scenario: Pi conversation create

- **WHEN** a supported Adapter observes the unique Pi Composer before native creation
- **THEN** the native conversation `thread/start` carries `codexhost/pi-native` as its internal Model transport token

#### Scenario: Codex conversation create

- **WHEN** the Composer selects Codex
- **THEN** the Adapter restores the captured opaque official state and the native create retains official Model behavior

#### Scenario: Unsupported or ambiguous Renderer

- **WHEN** the asset, atom pair, Model target, installation timing, or Composer association is unsupported or ambiguous
- **THEN** Pi creation is blocked with an explicit unavailable state and no request is silently routed to Codex

#### Scenario: Transport state is temporary

- **WHEN** Pi is selected and later a new Codex Composer is mounted
- **THEN** the Adapter restores the opaque pre-Pi state without persisting `codexhost/pi-native` as the user default Model

### Requirement: Pi title generation does not enter Codex Harness

The versioned main-process policy SHALL bind each supported metadata generation service to its owning Renderer window and SHALL prevent a locked Pi Composer from creating an official Codex title Thread.

#### Scenario: Pi first Turn requests an automatic title

- **WHEN** the owning Renderer reports one uniquely locked Pi Composer
- **THEN** title generation returns no remote title and Codex Desktop uses its existing local fallback without an official ephemeral `thread/start`

#### Scenario: Codex first Turn requests an automatic title

- **WHEN** the owning Renderer reports one uniquely locked Codex Composer
- **THEN** the original official title service behavior is preserved

#### Scenario: Title ownership is ambiguous

- **WHEN** the service owner, Probe, or locked Composer cannot be determined uniquely
- **THEN** remote title generation is skipped rather than sending potentially Pi-owned content to Codex

### Requirement: Prewarm ownership does not create unused Pi processes

The Host SHALL establish Pi Thread ownership at `thread/start` and SHALL defer `PiRpcSession` startup until the first `turn/start` for that exact Thread ID.

#### Scenario: Multiple prewarm Threads

- **WHEN** one Composer interaction creates multiple Pi prewarm Threads and only one receives `turn/start`
- **THEN** only the consumed Thread starts a Pi Native Session

#### Scenario: Continued Pi Thread

- **WHEN** a later Turn starts for a consumed Pi Thread
- **THEN** the Host reuses the same Pi Native Session

#### Scenario: Host closes with unused prewarms

- **WHEN** the Host closes while Pi prewarm Threads were never consumed
- **THEN** no Pi child processes exist for those unused Threads

### Requirement: Controlled validation proves end-to-end routing

The controlled Gate SHALL associate sanitized create and Turn observations before claiming a real Pi route.

#### Scenario: Transport-only verification

- **WHEN** Codex and Pi Composers trigger conversation `thread/start` calls
- **THEN** Host observations classify Codex creates as `official-model` and Pi creates as `pi-transport`

#### Scenario: Sanitized Thread association

- **WHEN** a create response and later `turn/start` refer to the same Thread
- **THEN** the observation records a matched anonymous create ordinal, selected Harness, and non-sensitive Thread purpose without recording the Thread ID

#### Scenario: Real Pi verification

- **WHEN** transport verification passes and a Pi-selected Composer submits its first Turn
- **THEN** the Host selects Pi, starts one Pi Native Session, and projects the Pi response into the same Codex Thread

#### Scenario: Pi continuation verification

- **WHEN** the same Pi Thread submits a later Turn
- **THEN** no new `thread/start` occurs and the existing Pi Native Session is reused

#### Scenario: Diagnostic privacy

- **WHEN** the Gate records Renderer, Host, title policy, and Session evidence
- **THEN** it omits Prompt text, input values, Transcript, full DOM, Model values, and complete request or Thread IDs
