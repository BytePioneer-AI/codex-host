## ADDED Requirements

### Requirement: Account changes SHALL use one native backend and one session store
Managed Codex SHALL use one canonical permanent home and at most one live Host-owned official app-server, including authentication staging. Account changes MUST stop and prove the owned writer tree has exited before replacing native credentials. They MUST NOT proxy Model requests, alter Provider headers, route Threads by Account, or create permanent per-Account homes.

#### Scenario: Switch A to B
- **WHEN** the user selects saved B
- **THEN** Host SHALL save stopped A's latest credentials, install B, restart and authenticate B before committing current=B
- **AND** Desktop, Host, external Harnesses and native Thread IDs SHALL remain intact
- **AND** subsequent Turns in existing Codex Threads SHALL use the new global identity without replaying earlier requests

#### Scenario: Exit is unconfirmed
- **WHEN** Host cannot prove the owned backend tree or the external stop batch has exited
- **THEN** it SHALL NOT install target credentials
- **AND** a closed transport alone SHALL NOT count as proof of process-tree exit

### Requirement: Account switching SHALL stop native backends without an idle scan
Switching SHALL enter changing synchronously, reject new work before connection or automatic startup, stop the owned backend and then the detected external Codex backends before replacing credentials. This SHALL be the only switching strategy, with no experimental flags or quota-drain queue. Login, logout and recovery SHALL retain their existing admission rules.

#### Scenario: Native requests and work are pending
- **WHEN** the user switches while native requests, including quota reads, or native work are pending
- **THEN** Host SHALL stop without scanning Thread, Goal, queue or temporary-session state
- **AND** outstanding native RPCs SHALL fail explicitly and release their leases on retirement, without poisoning changing admission merely because stop was intentional
- **AND** new work and concurrent switching SHALL fail immediately, without replay into the target Account
- **AND** independent Host credential-writer leases SHALL NOT be cleared to force credential replacement

#### Scenario: VS Code restarts its Codex backend
- **WHEN** an editor starts a new backend after the detected batch was stopped
- **THEN** Host SHALL NOT repeatedly hunt replacement processes
- **AND** success SHALL depend on target native credentials and the verified Host-owned backend, not synchronized identity across all clients

### Requirement: Managed startup SHALL be owned by Account recovery
The dedicated management connection SHALL initialize before Desktop clients. A managed Runtime Scope MUST NOT bypass failed Account initialization by starting a backend or publishing ready itself. Known protocol incompatibility without pending state SHALL be distinguished from recovery or ownership conflicts.

#### Scenario: Cold startup before Desktop attaches
- **WHEN** Account recovery needs native configuration or authentication
- **THEN** it SHALL use a unique management-only backend without depending on Desktop initialization
- **AND** recovery records SHALL be interpreted before importing native credentials

#### Scenario: Management unsupported but native use is safe
- **WHEN** no transaction or ownership conflict exists and management is unavailable because of storage, key or version capability
- **THEN** the native single-account path SHALL retain ordinary native authentication semantics without creating plaintext credential backups
- **AND** SSH SHALL retain remote authentication without transferring local credentials

#### Scenario: Recovery is blocked
- **WHEN** ownership, identity or exit facts cannot safely be established
- **THEN** only Codex SHALL remain unavailable and existing external Harness work SHALL not be globally closed
- **AND** recover SHALL be advertised only when the live control can actually retry it

### Requirement: Desktop transport initialization SHALL remain independent of native readiness
When native Account admission is unavailable or changing, Host SHALL acknowledge Desktop initialization using Host-owned transport metadata without claiming native readiness, authentication or Model capabilities. It SHALL retain the client's native initialization parameters and attachment for recovery. A terminally closed Host client or Scope MUST NOT acknowledge new initialization.

#### Scenario: Desktop starts while native recovery is blocked
- **WHEN** Desktop sends initialize while native startup is blocked
- **THEN** Host SHALL return its own identity, permanent Codex home and runtime platform instead of turning native unavailability into a fatal initialization error
- **AND** native work SHALL remain rejected while external Harness requests remain available

#### Scenario: Desktop connects during authentication staging
- **WHEN** an authentication-only staging backend is running
- **THEN** Desktop initialization SHALL NOT connect a task client to that backend or stop it
- **AND** initialization metadata SHALL identify the permanent home, not the staging directory

#### Scenario: Recovery follows Host-only initialization
- **WHEN** the Account coordinator safely restores native readiness
- **THEN** the existing Desktop client SHALL initialize its native connection using the original negotiation parameters
- **AND** Host SHALL NOT require Desktop restart or replay its earlier initialization response

#### Scenario: A recovered native generation fails before Desktop disconnects
- **WHEN** recovered native work loses its transport and Desktop requests active-work draining
- **THEN** Host SHALL retain that work until the Owner proves the writer has stopped
- **AND** every confirmed backend retirement SHALL settle attached clients' native work bookkeeping, independently of any one-shot startup failure notification
- **AND** client detach, EOF and an unconfirmed stop SHALL NOT emit that retirement fact

### Requirement: Thread restoration SHALL preserve native identity and generation
Account replacement SHALL retain native Thread IDs, persisted history and Harness ownership through native resume semantics. Host SHALL retain subscription parameters and lazy restoration, without fabricating replacement Threads. Switching SHALL NOT scan Threads to capture settings; lossless recovery of temporary content and all runtime settings is not guaranteed. When an authoritative settings snapshot exists from an idle-only mutation, restoration SHALL verify it before dispatching the requested Turn.

#### Scenario: Native settings changed after initial Thread creation
- **WHEN** an idle-only mutation captures a Thread's authoritative settings after its original start request
- **THEN** the replacement generation SHALL restore the actual latest settings before admitting subsequent work
- **AND** late frames from a retired generation SHALL not update the new generation

#### Scenario: A native path names an unmaterialized rollout
- **WHEN** an idle-only mutation probes a loaded Thread and native resume confirms no rollout exists
- **THEN** Host SHALL reject that mutation as busy while preserving the live Thread and writer
- **AND** it SHALL NOT infer persistence from the path field, fabricate a replacement Thread, or report failed authentication

### Requirement: Native Desktop authentication SHALL retain its protocol semantics
Managed native ChatGPT OAuth and device-code login SHALL use the same Account coordinator and transaction as Settings, but SHALL activate the signed-in identity. Native branding and streamlined-login parameters SHALL reach the native login backend. Unsupported token-injection and non-ChatGPT modes MUST NOT bypass managed credential ownership.

#### Scenario: Native completion precedes the start response
- **WHEN** native authentication completes before its start response can be delivered
- **THEN** Host SHALL deliver the native response before its matching account/login/completed event
- **AND** operation correlation and supported onboarding metadata SHALL be preserved
- **AND** native cancellation SHALL return canceled/notFound status rather than the Settings boolean envelope

#### Scenario: Permanent backend generation becomes ready
- **WHEN** a replacement or recovered permanent backend is verified and ready
- **THEN** Host SHALL notify initialized Desktop clients with account/updated derived from that backend's actual account/read result
- **AND** staging, retired-generation results and saved-but-unavailable state SHALL NOT be announced as authenticated readiness
- **AND** an observer failure or slow Desktop writer SHALL NOT roll back committed credentials or hold the credential-change admission lease

### Requirement: Public Account state SHALL express global committed facts
The browser-safe v2 Account snapshot SHALL expose ready/changing/unavailable, revision and Host identity, capabilities, committed current metadata and necessary operation/cleanup status, but no credentials or private paths. Only Settings SHALL offer global switching. Composer SHALL not submit per-draft Account selectors; Harness locking SHALL remain independent.

#### Scenario: Commit succeeds but cleanup fails
- **WHEN** the Vault commit is durable but cleanup or native readiness is incomplete
- **THEN** the UI SHALL distinguish saved/committed Account state from readiness
- **AND** old Host or old revision responses SHALL not replace newer state

#### Scenario: Desktop replaces its Request Client while an Account response is in flight
- **WHEN** Desktop changes its internal Request Client after an Account request was sent and receives that request's response
- **THEN** the response SHALL complete the original request without dispatching another Account operation
- **AND** a busy rejection SHALL end Settings' pending state and permit explicit user retry without weakening admission
- **AND** successful native delivery SHALL NOT be completed twice, and another Host or unowned request ID SHALL NOT complete this request

#### Scenario: Desktop resets navigation after switching Accounts
- **WHEN** a successful Settings switch rebuilds Desktop's navigation while the window was displaying a local native Codex Thread
- **THEN** Renderer SHALL retain that Thread ID for the operation and open the same Thread through the native UI once the replacement view is available
- **AND** rejection, newer user navigation, expiration or disposal SHALL stop restoration without retrying the Account operation or replaying any Thread input
- **AND** this window-local navigation intent SHALL NOT persist an Account-to-Thread mapping or reuse a retired Client

#### Scenario: Retired account-selection API is used
- **WHEN** a client submits activate or per-draft account-selection input
- **THEN** Host SHALL reject it rather than silently restoring per-Thread routing
