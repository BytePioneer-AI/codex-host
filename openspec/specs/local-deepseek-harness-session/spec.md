# local-deepseek-harness-session Specification

## Purpose
定义精确 DSH 0.1.2-rc.1 / 0.1.5-rc.1 托管 Web Remote、原生会话与生命周期保证；当前支持范围由 support-dsh-015rc1 更新。
## Requirements
### Requirement: Local DSH Web profile is the runtime source of truth

The DeepSeek Harness Adapter SHALL use a managed authenticated loopback Web Remote started from the user's local DSH Web profile with exact version `0.1.2-rc.1` or `0.1.5-rc.1`. codexhost MUST NOT substitute a private Cordis composition, credentials provider, Skill catalog, or Native Session store, and MUST NOT attach through the retired Legacy Host protocol.

#### Scenario: Supported DSH Web is already running externally
- **WHEN** the configured loopback endpoint exposes the recognized unauthenticated DSH Web fingerprint
- **THEN** the Adapter SHALL report missing authentication and instruct the user to close that instance and retry diagnostics
- **AND** it MUST NOT reuse unknown credentials or stop the external process

#### Scenario: DSH Web is not running
- **WHEN** an exact supported local command is available
- **THEN** codexhost SHALL start `web --no-open --host 127.0.0.1 --port 0`, authenticate its managed Web and wait a bounded time
- **AND** normal use SHALL NOT require the user to start DSH manually

#### Scenario: Endpoint belongs to another service
- **WHEN** the configured endpoint responds without the recognized DSH fingerprint
- **THEN** the Adapter MUST NOT terminate, replace, attach to, or send Session content to that service
- **AND** any supported managed Web SHALL use its own ephemeral loopback port

### Requirement: codexhost creates official DSH Native Sessions

Every new DeepSeek Thread SHALL be backed by a Session created through the managed DSH Remote and persisted by the official DSH Session store. codexhost MUST NOT read or duplicate the native transcript files; it SHALL parse only the public history API.

#### Scenario: New codexhost DeepSeek Thread is created
- **WHEN** Host Runtime opens the Adapter with `kind=create`
- **THEN** the Adapter SHALL call the native Session create API with the Thread cwd
- **AND** SHALL publish the native Session ID as the stable Native Session reference

#### Scenario: Official DSH lists Sessions
- **WHEN** DSH Web lists its persisted Sessions after codexhost creates and uses a DeepSeek Thread
- **THEN** the codexhost-created Native Session SHALL be present with the same Session ID and transcript

### Requirement: Session visibility is one-way

codexhost SHALL list and restore only DeepSeek Native Sessions referenced by its own persisted external Thread records. An existing Session SHALL enter this set only through explicit supported-version import, with fresh native candidate validation and a mapping-only transaction.

#### Scenario: DSH contains older official Sessions
- **WHEN** the local DSH store contains Sessions created outside codexhost
- **THEN** those Sessions SHALL remain visible in official DSH Web
- **AND** they SHALL NOT appear as codexhost Threads until explicitly imported

#### Scenario: codexhost restarts
- **WHEN** Mapping Store contains one DeepSeek Native Session reference and DSH contains additional Sessions
- **THEN** codexhost SHALL restore only the mapped Session through its exact Native ID and selected version profile

### Requirement: Public history and live events are authoritative

The Adapter SHALL build Snapshot and live Harness outputs only from the official DSH Web Remote history and event APIs. It SHALL preserve native order and selected-format semantics for each Session.

#### Scenario: Mapped Session resumes after application restart
- **WHEN** Host opens a valid mapped DeepSeek Native Session reference
- **THEN** the Adapter SHALL read its public native history through the selected V0 or V3 profile and return a standard Snapshot
- **AND** a later Turn SHALL continue the same Native Session

#### Scenario: Live stream disconnects
- **WHEN** a DSH event connection is interrupted
- **THEN** the Adapter SHALL perform bounded supported recovery or explicitly fault the Session
- **AND** recovery SHALL use public history and the matching assistant baseline without reading native JSONL files

### Requirement: DSH Permission Modes remain dynamically provider-owned
The Adapter SHALL discover the selectable Permission Mode catalog from the native `permission` settings namespace and SHALL read each Session's effective mode from the authoritative `permissions` projection. It MUST NOT hardcode preset IDs, order, labels, descriptions, or defaults, parse command settlement text as state, or substitute Agent composition presets.

#### Scenario: New Session selects a native permission preset
- **WHEN** create input names one mode from the inspected catalog
- **THEN** the Adapter SHALL create the official Session, invoke the native permission command, and confirm the requested value through a fresh projection read
- **AND** it SHALL publish the confirmed mode in the complete initial Session state

#### Scenario: Mapped Session resumes or refreshes
- **WHEN** the Adapter opens a mapped Session or reads its Snapshot
- **THEN** it SHALL restore the current native mode from the history-tail projection
- **AND** higher-sequence live projection updates SHALL synchronize the complete Session state without allowing stale updates to overwrite them

#### Scenario: Native permission state cannot be confirmed
- **WHEN** the catalog, command capability, projection, or post-selection readback is missing, malformed, or inconsistent
- **THEN** the affected inspection, open, read, or selection SHALL fail closed
- **AND** codexhost SHALL NOT report the requested mode optimistically

### Requirement: Native turn operations remain truthful
The Adapter SHALL map native prompt, cancellation, text, Reasoning, Tool, structured Diff, Usage, and terminal events to existing Harness contracts. It SHALL fail explicitly when the local Host rejects an operation or emits an unsupported interactive request.

#### Scenario: Full-profile tool executes
- **WHEN** the active local DSH profile invokes any registered tool and emits its standard Tool events
- **THEN** codexhost SHALL project the Tool lifecycle generically
- **AND** the tool's availability and behavior SHALL remain owned by DSH

#### Scenario: Active turn requests an unsupported interaction
- **WHEN** DSH requests an approval or user question that the Adapter cannot represent
- **THEN** the active Host Turn SHALL fail explicitly or expose the supported standard interaction
- **AND** it MUST NOT auto-approve, fabricate a response, or remain pending indefinitely

#### Scenario: Native cancellation is accepted
- **WHEN** codexhost cancels an active DeepSeek Turn and the Host accepts `session.cancel`
- **THEN** the Adapter SHALL accept cancellation and complete the Turn exactly once from authoritative native state

### Requirement: DSH Host lifecycle ownership is bounded

The Adapter SHALL own only the managed Web process it started. It MUST NOT stop an externally owned Web, and SHALL preserve bounded cleanup and native execution-stop confirmation during shutdown.

#### Scenario: External Web is detected
- **WHEN** codexhost reports the external instance's missing authentication
- **THEN** closing the Adapter SHALL NOT terminate the external DSH process

#### Scenario: Adapter closes a managed Host
- **WHEN** codexhost started DSH Web and later shuts down
- **THEN** it SHALL stop native work and request bounded process termination after closing Sessions and connections
- **AND** official persistence SHALL remain available on the next DSH start
