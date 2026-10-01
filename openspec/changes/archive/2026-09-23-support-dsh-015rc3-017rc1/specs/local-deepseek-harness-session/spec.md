## MODIFIED Requirements

### Requirement: Local DSH Web profile is the runtime source of truth

The DeepSeek Harness Adapter SHALL use a managed authenticated loopback Web Remote started from the user's local DSH Web profile. Versions `0.1.5-rc.3` and `0.1.7-rc.1` SHALL be added to the verified list only after their respective native lifecycle Gates pass; other normative SemVer versions MUST pass the selected native protocol checks before being reported ready. codexhost MUST NOT substitute a private Cordis composition, credentials provider, Skill catalog, or Native Session store, and MUST NOT attach through the retired Legacy Host protocol.

#### Scenario: Supported DSH Web is already running externally
- **WHEN** the configured loopback endpoint exposes the recognized unauthenticated DSH Web fingerprint
- **THEN** the Adapter SHALL report missing authentication and instruct the user to close that instance and retry diagnostics
- **AND** it MUST NOT reuse unknown credentials or stop the external process

#### Scenario: DSH Web is not running
- **WHEN** a local command with a normative SemVer version is available
- **THEN** codexhost SHALL start `web --no-open --host 127.0.0.1 --port 0`, authenticate its managed Web and wait a bounded time
- **AND** it SHALL validate the selected native protocol before reporting ready

#### Scenario: Endpoint belongs to another service
- **WHEN** the configured endpoint responds without the recognized DSH fingerprint
- **THEN** the Adapter MUST NOT terminate, replace, attach to, or send Session content to that service
- **AND** any supported managed Web SHALL use its own ephemeral loopback port

### Requirement: Public history and live events are authoritative

The Adapter SHALL build Snapshot and live Harness outputs only from the official DSH Web Remote history and event APIs. It SHALL preserve native order and selected V0, V3 or V4 format semantics for each Session, including a DSH-owned migration before a newer CLI reads older native data.

#### Scenario: Mapped Session resumes after application restart
- **WHEN** Host opens a valid mapped DeepSeek Native Session reference
- **THEN** the Adapter SHALL read its public native history through the selected profile and return a standard Snapshot
- **AND** a later Turn SHALL continue the same Native Session

#### Scenario: Live stream disconnects
- **WHEN** a DSH event connection is interrupted
- **THEN** the Adapter SHALL perform bounded supported recovery or explicitly fault the Session
- **AND** recovery SHALL use public history and the matching assistant baseline without reading native JSONL files

#### Scenario: DSH migrates a Session to V4
- **WHEN** `0.1.7-rc.1` opens a native Session that DSH migrated from V3 to V4
- **THEN** the Adapter SHALL read and validate the current V4 history without performing its own file migration
- **AND** any pre-migration checkpoint SHALL NOT authorize a mutating Fork or rollback
