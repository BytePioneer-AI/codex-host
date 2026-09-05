## ADDED Requirements

### Requirement: Candidate discovery uses the optional Adapter capability and exact Modern Session Remote

`HarnessAdapter` SHALL define one optional Session Import capability that lists bounded SDK-free candidate metadata and does not expose Host RPC, Mapping Store, Host Thread or Transcript operations. The concrete DeepSeek Adapter SHALL implement that capability only through an exact `0.1.2-rc.1` Modern lifetime delegate. It SHALL call the authenticated `session/list` Remote with exact args `{ _request: {} }`, validate the complete response under finite byte, depth, node, item and field limits, and expose only bounded SDK-free candidate metadata. It MUST NOT use Legacy `sessions.list`, scan Native storage, read history to synthesize metadata, attach an external Modern Web, or expose DSH wire objects outside the Adapter package.

#### Scenario: Modern profile contains importable history

- **WHEN** exact rc.1 returns unique ordinary non-blank Sessions with canonical absolute cwd metadata
- **THEN** Adapter SHALL preserve their native order and expose only Native Session ID, cwd, title or null, update time and momentary running state
- **AND** a normal Fork Session with `parentSessionId` but without `origin=subagent` SHALL remain eligible

#### Scenario: Valid row is not importable history

- **WHEN** a valid list row is a Subagent, blank, or lacks a canonical absolute cwd
- **THEN** it SHALL not become an importable candidate
- **AND** no Native Session SHALL be opened or mutated

#### Scenario: Session list identity is malformed or ambiguous

- **WHEN** a row has an invalid identity or update time, two rows use the same Session ID, or the response violates its declared shape
- **THEN** the complete list request SHALL fail with a sanitized protocol error instead of silently dropping the malformed row
- **AND** Renderer SHALL receive no partial candidate list

#### Scenario: Legacy is selected

- **WHEN** the public DeepSeek Facade has selected exact `0.1.1-rc.2` Legacy
- **THEN** its Session Import capability SHALL return `unsupported`
- **AND** it SHALL NOT call Legacy Session list, resume, history or mutation APIs

#### Scenario: Another Harness does not implement import

- **WHEN** another registered Adapter omits the optional Session Import capability
- **THEN** that Adapter SHALL remain valid without placeholder methods or behavior changes
- **AND** the DeepSeek implementation SHALL impose no native discovery semantics on it

#### Scenario: Candidate response exceeds a bound

- **WHEN** `session/list` exceeds a declared response, work, collection or field limit
- **THEN** discovery SHALL fail with a sanitized protocol error instead of returning a partial list
- **AND** no token, cookie or bootstrap URL SHALL enter the error or Renderer contract

### Requirement: Host revalidates the selected Native Session

The fixed import method SHALL accept only one bounded `nativeSessionId`. Immediately before persistence, Host SHALL obtain a fresh Modern candidate list and fresh Mapping Store view, require the exact Session to remain eligible and not running, and derive cwd/title only from that native result. Renderer-provided display metadata MUST NOT influence persistence.

#### Scenario: Candidate remains idle and eligible

- **WHEN** the selected Native Session remains present, ordinary, non-blank, unmapped and not running in the fresh list
- **THEN** Host MAY begin the mapping transaction using its fresh native cwd and title
- **AND** it SHALL ignore stale list metadata retained by Renderer

#### Scenario: Candidate changes after display

- **WHEN** the Session disappears, becomes a Subagent or blank, loses valid cwd, becomes running, or gains an existing mapping before import
- **THEN** Host SHALL reject or idempotently resolve the request before creating a conflicting ready record
- **AND** it SHALL invoke no DSH mutation API

### Requirement: Import commits metadata only

Host SHALL import an eligible Session by creating one provisional External Thread record and committing one exact DeepSeek Native Session Ref with zero initial Turn mappings. Import MUST NOT open or resume the Session, read a Snapshot, register a live Runtime, copy Transcript data, or call DSH create, fork, prompt, cancel, Model, Thinking, Permission or command operations.

#### Scenario: Existing Session imports successfully

- **WHEN** fresh validation and Mapping Store commit succeed
- **THEN** exactly one ready V1 record SHALL contain the DSH-provided cwd/title, default DeepSeek transport carrier, `ephemeral=false`, `historyMode=paginated`, the exact Native Session ID and `turnMappings=[]`
- **AND** Host SHALL return its new Host Thread ID and publish one `thread/started` notLoaded projection

#### Scenario: Import fails before ready commit

- **WHEN** provisional creation, fresh validation, Native Ref commit or durable write fails
- **THEN** Host SHALL return one explicit error and remove any provisional record it created
- **AND** it SHALL emit no successful import result or `thread/started`

#### Scenario: Import is repeated

- **WHEN** the same Native Session already has a ready non-Subagent DeepSeek mapping
- **THEN** Host SHALL idempotently return that mapping's Host Thread ID or reject a still-running duplicate attempt
- **AND** Mapping Store SHALL never contain two ready owners for the same Harness and Native Session identity

### Requirement: Imported history uses the standard lazy recovery path

An imported ready mapping SHALL enter the ordinary External Thread list without loading DSH. The first Thread operation that requires a live Session or history SHALL use the existing Modern resume, journal Snapshot and Repository alignment path to restore the exact Native Session and populate stable Host Turn mappings.

#### Scenario: Imported Thread first opens

- **WHEN** Desktop opens the returned notLoaded Thread
- **THEN** `ExternalThreadRuntime` SHALL resume its exact Native Session through Modern `session/follow` and `session/page`, read the standard Snapshot and reconcile Turn mappings
- **AND** a later user Turn SHALL continue that same Native Session

#### Scenario: Native Session becomes unavailable after import

- **WHEN** mapping commit succeeded but first resume later reports the Native Session unavailable or busy
- **THEN** the standard Thread operation SHALL expose that native failure without fabricating history
- **AND** the ready mapping SHALL remain durable for retry or ordinary user-managed deletion

#### Scenario: DSH adds history outside codexhost

- **WHEN** a later Snapshot contains additional Native Turn identities
- **THEN** existing Host Turn IDs SHALL remain stable and alignment SHALL append mappings in authoritative order
- **AND** codexhost SHALL not persist a second Transcript copy
