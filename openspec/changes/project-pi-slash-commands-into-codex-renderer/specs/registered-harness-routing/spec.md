## ADDED Requirements

### Requirement: Host routes command discovery through registered Harness ownership
Host Runtime SHALL route draft command discovery through the requested registered HarnessAdapter and live command discovery through the target external Thread's immutable owning HarnessSession. AppServerHost SHALL NOT branch on Pi command names, invoke Pi RPC, scan Harness files, or forward an external command-catalog request to official Codex.

#### Scenario: Registered Harness draft requests commands
- **WHEN** a valid draft inspection names a registered Harness, includes one exact cwd, and requests its command catalog
- **THEN** Host SHALL call that Adapter's generic `inspect()` command-discovery path
- **AND** it SHALL return the normalized result without opening a durable Thread mapping

#### Scenario: Loaded external Thread requests commands
- **WHEN** a valid live command request names a loaded external Thread
- **THEN** Host SHALL call `getCommandCatalog()` on that Thread's owning Session
- **AND** it SHALL NOT call another registered Adapter

#### Scenario: Persisted external Thread is unloaded
- **WHEN** a command request names a persisted external Thread whose Session is not loaded
- **THEN** Host SHALL use generic persisted ownership and resume behavior to query the owning Harness or return an explicit supported error
- **AND** it SHALL NOT fall through to official Codex

#### Scenario: Codex-owned Thread reaches the external command method
- **WHEN** the fixed live external command request names a Codex-owned Thread
- **THEN** Host SHALL return an explicit ownership or unsupported error
- **AND** it SHALL NOT forward the custom method or query a registered external Adapter

### Requirement: Host command discovery remains bounded and content-private
Host SHALL validate fixed command discovery params and results, use only bounded process-local coalescing or caching, and keep native provenance and user command content out of diagnostics.

#### Scenario: Draft query omits exact cwd
- **WHEN** a draft command request lacks a valid non-blank cwd
- **THEN** Host SHALL reject the request before invoking an Adapter
- **AND** it SHALL NOT substitute Host process cwd

#### Scenario: Adapter returns an invalid descriptor
- **WHEN** a catalog contains duplicate, unbounded, malformed, or undeclared data
- **THEN** Host SHALL reject the catalog at the formal boundary rather than send a partial result to Renderer

#### Scenario: Command discovery is observed
- **WHEN** Host records sanitized command discovery evidence
- **THEN** it MAY record Harness classification, counts, kinds, and cache outcome
- **AND** it SHALL omit descriptions, source paths, arguments, Prompt content, Transcript, credentials, and complete Thread IDs
