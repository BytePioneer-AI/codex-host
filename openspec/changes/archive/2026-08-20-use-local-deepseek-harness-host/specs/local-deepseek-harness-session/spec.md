## ADDED Requirements

### Requirement: Local DSH Web profile is the runtime source of truth
The DeepSeek Harness Adapter SHALL use a compatible loopback Host started from the user's local DSH Web profile. codexhost MUST NOT substitute a private Cordis composition, private credentials provider, private Skill catalog, or private Native Session store.

#### Scenario: Compatible DSH Web is already running
- **WHEN** the configured loopback endpoint serves a compatible DSH Host
- **THEN** the Adapter SHALL connect to that Host without starting or stopping another DSH process
- **AND** every Session SHALL use that Host's active tools, Skills, settings, credentials, presets, permissions, and model routes

#### Scenario: DSH Web is not running
- **WHEN** no compatible Host is reachable and a configured local DSH command is available
- **THEN** codexhost SHALL start its Web profile and wait a bounded time for the Host API
- **AND** normal use SHALL NOT require the user to start DSH manually

#### Scenario: Endpoint belongs to another service
- **WHEN** the configured endpoint responds without the compatible DSH Host contract
- **THEN** the Adapter SHALL report unavailable or protocol error
- **AND** it MUST NOT terminate, replace, or send Session content to that service

### Requirement: codexhost creates official DSH Native Sessions
Every new DeepSeek Thread SHALL be backed by a Session created through the local DSH Host and persisted by the official DSH Session store. codexhost MUST NOT parse or duplicate the DSH Native transcript.

#### Scenario: New codexhost DeepSeek Thread is created
- **WHEN** Host Runtime opens the Adapter with `kind=create`
- **THEN** the Adapter SHALL call the native Session create API with the Thread cwd
- **AND** SHALL publish the returned DSH Session ID as the stable Native Session reference

#### Scenario: Official DSH lists Sessions
- **WHEN** DSH Web lists its persisted Sessions after codexhost creates and uses a DeepSeek Thread
- **THEN** the codexhost-created Native Session SHALL be present with the same Session ID and transcript

### Requirement: Session visibility is one-way
codexhost SHALL list and restore only DeepSeek Native Sessions referenced by its own persisted external Thread records. It MUST NOT import, enumerate into Threads, or claim ownership of pre-existing DSH Sessions.

#### Scenario: DSH contains older official Sessions
- **WHEN** the local DSH store contains Sessions created outside codexhost
- **THEN** those Sessions SHALL remain visible in official DSH Web
- **AND** they SHALL NOT appear in codexhost unless a future explicit import capability is defined

#### Scenario: codexhost restarts
- **WHEN** Mapping Store contains one DeepSeek Native Session reference and DSH contains additional Sessions
- **THEN** codexhost SHALL restore only the mapped Session through its exact Native ID

### Requirement: Public history and live events are authoritative
The Adapter SHALL build Snapshot and live Harness outputs only from the official DSH Host history and event APIs. It SHALL preserve native event order for each loaded Session.

#### Scenario: Mapped Session resumes after application restart
- **WHEN** Host opens the Adapter with a valid mapped DeepSeek Native Session reference
- **THEN** the Adapter SHALL read its public native history and return a standard Host Thread Snapshot
- **AND** a later Turn SHALL continue the same Native Session

#### Scenario: Live stream disconnects
- **WHEN** the DSH event connection is interrupted
- **THEN** the Adapter SHALL fault the loaded Session explicitly
- **AND** a later mapped resume SHALL use public Session history without reading DSH JSONL

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
The Adapter SHALL distinguish an existing external Host from a Host process it started. It MUST NOT stop an externally owned Host, and SHALL stop only its managed process during Adapter shutdown.

#### Scenario: Adapter closes after connecting to user Host
- **WHEN** codexhost shuts down after using an already-running DSH Web Host
- **THEN** it SHALL close its event connection without terminating DSH Web

#### Scenario: Adapter closes a managed Host
- **WHEN** codexhost started DSH Web and later shuts down
- **THEN** it SHALL request bounded process termination after closing Sessions and connections
- **AND** official Native Session persistence SHALL remain available on the next DSH start
