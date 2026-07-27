## ADDED Requirements

### Requirement: Composer Agent locks before native creation
The Renderer Extension SHALL keep Agent state isolated by Composer and SHALL lock the selected Agent during the first `beforeinput` that can trigger native Thread creation.

#### Scenario: Pi is selected before input
- **WHEN** a user selects Pi in an empty new-Thread Composer and begins input
- **THEN** the Composer Agent is locked to Pi before any related `thread/start`

#### Scenario: User attempts to switch after input
- **WHEN** a Composer Agent is locked
- **THEN** the Agent controls are disabled and selecting another Agent requires a new Thread

### Requirement: Versioned Adapter decorates the same create request
For a supported Desktop build, the Renderer Adapter SHALL clone the current `thread/start` parameters and SHALL set the clone's Model to `codexhost/pi-native` only when the uniquely associated locked Composer selects Pi.

#### Scenario: Pi create request
- **WHEN** a supported Adapter observes a create call for the unique locked Pi Composer
- **THEN** the same create call receives cloned parameters whose Model is `codexhost/pi-native`

#### Scenario: Codex create request
- **WHEN** the locked Composer selects Codex
- **THEN** the Adapter leaves the official Model and request behavior unchanged

#### Scenario: Unsupported or ambiguous Renderer
- **WHEN** the build, structure signature, installation timing, or Composer association is unsupported or ambiguous
- **THEN** Pi creation is blocked with an explicit unavailable state and no request is silently routed to Codex

### Requirement: Prewarm ownership does not create unused Pi processes
The Host SHALL establish Pi Thread ownership at `thread/start` and SHALL defer `PiRpcSession` startup until the first `turn/start` for that exact Thread ID.

#### Scenario: Multiple prewarm Threads
- **WHEN** one Composer interaction creates multiple Pi prewarm Threads and only one receives `turn/start`
- **THEN** only the consumed Thread starts a Pi Native Session

#### Scenario: Continued Pi Thread
- **WHEN** a second Turn starts for a consumed Pi Thread
- **THEN** the Host reuses the same Pi Native Session

#### Scenario: Host closes with unused prewarms
- **WHEN** the Host closes while Pi prewarm Threads were never consumed
- **THEN** no Pi child processes exist for those unused Threads

### Requirement: Controlled validation proves end-to-end routing
The controlled Gate SHALL separately prove transport decoration before claiming a real Pi route and SHALL retain only sanitized structural evidence.

#### Scenario: Transport-only verification
- **WHEN** Codex and Pi Composers trigger all related `thread/start` calls
- **THEN** Host observations classify Codex calls as `official-model` and Pi calls as `pi-transport`

#### Scenario: Real Pi verification
- **WHEN** transport verification passes and a Pi-selected Composer submits its first Turn
- **THEN** the Host selects Pi, starts one Pi Native Session, and projects the Pi response into the same Codex Thread

#### Scenario: Diagnostic privacy
- **WHEN** the Gate records Renderer, Host, and Session evidence
- **THEN** it omits Prompt text, input values, Transcript, full DOM, Model values, and complete request or Thread IDs
