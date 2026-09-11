## ADDED Requirements

### Requirement: Account changes SHALL use one native backend and one session store
Managed Codex SHALL use one canonical permanent home and at most one live official app-server, including authentication staging. Account changes MUST stop and prove the owned writer tree has exited before replacing native credentials. They MUST NOT proxy Model requests, alter Provider headers, route Threads by Account, or create permanent per-Account homes.

#### Scenario: Switch A to B while idle
- **WHEN** the user selects saved B with no active native work
- **THEN** Host SHALL save stopped A's latest credentials, install B, restart and authenticate B before committing current=B
- **AND** Desktop, Host, external Harnesses and native Thread IDs SHALL remain intact
- **AND** subsequent Turns in existing Codex Threads SHALL use the new global identity without replaying earlier requests

#### Scenario: Work or exit is unconfirmed
- **WHEN** a Turn, approval, terminal, realtime session, queue, goal or writer remains active or unconfirmed
- **THEN** Host SHALL reject the change without forced cancellation or deferred submission
- **AND** a closed transport SHALL NOT count as proof of process-tree exit or retire outstanding work

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

### Requirement: Thread restoration SHALL preserve native settings and generation
Account replacement SHALL retain native Thread IDs, history and Harness ownership, and preserve actual Model, Provider, reasoning and permission/workspace settings through native resume semantics. Host MUST NOT use stale initial draft values or fabricate replacement Threads. Unprovable restoration SHALL fail explicitly without dispatching the requested Turn.

#### Scenario: Native settings changed after initial Thread creation
- **WHEN** an idle Thread has more recent runtime settings than its original start request
- **THEN** the replacement generation SHALL restore the actual latest settings before admitting subsequent work
- **AND** late frames from a retired generation SHALL not update the new generation

### Requirement: Public Account state SHALL express global committed facts
The browser-safe v2 Account snapshot SHALL expose ready/changing/unavailable, revision and Host identity, capabilities, committed current metadata and necessary operation/cleanup status, but no credentials or private paths. Only Settings SHALL offer global switching. Composer SHALL not submit per-draft Account selectors; Harness locking SHALL remain independent.

#### Scenario: Commit succeeds but cleanup fails
- **WHEN** the Vault commit is durable but cleanup or native readiness is incomplete
- **THEN** the UI SHALL distinguish saved/committed Account state from readiness
- **AND** old Host or old revision responses SHALL not replace newer state

#### Scenario: Retired account-selection API is used
- **WHEN** a client submits activate or per-draft account-selection input
- **THEN** Host SHALL reject it rather than silently restoring per-Thread routing
