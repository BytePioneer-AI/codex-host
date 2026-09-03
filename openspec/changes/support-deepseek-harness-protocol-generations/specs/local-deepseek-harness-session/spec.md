## MODIFIED Requirements

### Requirement: Local DSH Web profile is the runtime source of truth

The DeepSeek Harness Adapter SHALL use a compatible loopback Host started from the user's local DSH Web profile. The supported release set SHALL contain only Legacy `0.1.1-rc.2` and Modern `0.1.2-rc.1`. codexhost MUST NOT substitute a private Cordis composition, private credentials provider, private Skill catalog, or private Native Session store.

#### Scenario: Compatible DSH Web is already running

- **WHEN** the configured or default loopback endpoint satisfies the complete exact rc.2 Host wire contract
- **THEN** the Adapter SHALL connect through the Legacy implementation without starting or stopping another DSH process
- **AND** every Session SHALL use that Host's active tools, Skills, settings, credentials, presets, permissions and model routes

#### Scenario: DSH Web is not running

- **WHEN** no compatible Legacy Host is attached and an exact `0.1.2-rc.1` local DSH command is available
- **THEN** codexhost SHALL start its Web profile on an OS-selected loopback port, authenticate through that process's readiness token and wait a bounded time for Remote readiness
- **AND** normal use SHALL NOT require the user to start DSH manually

#### Scenario: Modern DSH Web is already running

- **WHEN** the configured or default endpoint exactly matches the unauthenticated Modern Web root fingerprint but its process and bootstrap token are not owned by this Adapter
- **THEN** the Adapter SHALL report authentication required with an actionable bilingual message and SHALL NOT attach or start a competing Modern Web over the same DSH home
- **AND** it MUST NOT read credential storage, weaken authentication or send Session content

#### Scenario: Endpoint belongs to another service

- **WHEN** the configured endpoint responds without the complete exact rc.2 Host contract
- **THEN** the Adapter SHALL report unavailable, authentication required or protocol error according to the observed boundary
- **AND** it MUST NOT terminate, replace or send Session content to that service

### Requirement: Public history and live events are authoritative

The Adapter SHALL build Snapshot and live Harness outputs only from official DSH Host APIs. Legacy SHALL preserve its exact rc.2 history/event behavior. Modern SHALL attach `session/follow` before paging, use its opening cursor as one immutable `session/page.throughSeq`, buffer live events while reading every older page, and use `session/control` baseline/updates for authoritative live projections.

#### Scenario: Mapped Session resumes after application restart

- **WHEN** Host opens the Adapter with a valid mapped supported Modern Native Session reference
- **THEN** the Adapter SHALL follow that exact Session, page to the start of its native journal, validate a gap-free `0..cursor` history and then apply buffered live events
- **AND** a later Turn SHALL continue the same Native Session without reading DSH JSONL or importing another Session

#### Scenario: Live stream disconnects and continuity is recoverable

- **WHEN** a Modern follow or control connection is interrupted and a replacement opening snapshot/baseline proves continuity from the last committed seq
- **THEN** the Adapter SHALL repair or replace the affected generation without duplicating events or projections
- **AND** the loaded Session SHALL remain usable

#### Scenario: Live stream disconnects and continuity is not recoverable

- **WHEN** a replacement follow/control generation contains a gap, conflict, stale-only baseline or cannot be established within the recovery bound
- **THEN** the Adapter SHALL fault the loaded Session explicitly
- **AND** a later mapped resume SHALL reconstruct through public follow/page/control APIs without reading DSH JSONL

#### Scenario: Live stream disconnects

- **WHEN** a Modern follow or control connection is interrupted
- **THEN** the Adapter SHALL either prove continuity through a replacement generation or fault the loaded Session explicitly
- **AND** it SHALL NOT silently reset, duplicate events or read DSH JSONL

### Requirement: DSH Permission Modes remain dynamically provider-owned

The Adapter SHALL discover the selectable Permission Mode catalog from the native `permission` settings namespace and SHALL read each Session's effective options/current value from the authoritative `permissions` projection. Legacy SHALL obtain the projection through its rc.2 history/Mux contract; Modern SHALL obtain opening state from follow and live replacement state from `session/control`. Except for the exact `0.1.2-rc.1` unattended bridge defined below, it MUST NOT hardcode preset IDs, order, labels, descriptions or defaults, parse command settlement text as state, or substitute Agent composition presets.

#### Scenario: New Session selects a native permission preset

- **WHEN** create input names one mode from the inspected catalog
- **THEN** the Adapter SHALL create the official Session, invoke the native permission command and wait for a higher-sequence control projection that exactly confirms the requested value
- **AND** it SHALL publish the confirmed mode in the complete initial Session state

#### Scenario: Mapped Session resumes or refreshes

- **WHEN** the Adapter opens a mapped Session or receives a replacement control baseline
- **THEN** it SHALL restore the current native mode from the highest validated projection watermark
- **AND** stale updates SHALL NOT overwrite newer Session state

#### Scenario: Native permission state cannot be confirmed

- **WHEN** the settings catalog, command capability, projection, projection options or post-selection readback is missing, malformed, stale or inconsistent
- **THEN** the affected inspection, open, read or selection SHALL fail closed
- **AND** codexhost SHALL NOT report the requested mode optimistically

#### Scenario: Supported Modern Session requests unattended full access

- **WHEN** create input requests `unattended-full-access` without an explicit Permission Mode
- **THEN** the Adapter SHALL require the dynamic catalog to advertise the exact supported release's built-in `danger-full-access` preset, execute that native preset and wait for a higher matching `permissions` projection
- **AND** the first complete journal SHALL confirm the latest permission preset, sandbox mode and approval policy as `danger-full-access`, `danger-full-access` and `never`
- **AND** any missing or conflicting catalog, projection or journal fact SHALL make the Session open operation fail closed without reporting unattended access

#### Scenario: Create combines explicit Permission Mode and unattended policy

- **WHEN** create input supplies both a Permission Mode and `unattended-full-access`
- **THEN** the Adapter SHALL reject the request as invalid before creating a Native Session

### Requirement: DSH Host lifecycle ownership is bounded

The Adapter SHALL distinguish an attached Legacy Host from a Modern Host process it started. It MUST NOT stop an externally owned Host, SHALL refuse external Modern attachment in the first release, and SHALL stop only its managed process during Adapter shutdown or failed selection.

#### Scenario: Adapter closes after connecting to user Host

- **WHEN** codexhost shuts down after using an already-running exact rc.2 wire Host
- **THEN** it SHALL close its event connection without terminating DSH Web

#### Scenario: Adapter closes a managed Host

- **WHEN** codexhost started exact rc.1 Web and later shuts down
- **THEN** it SHALL release claimed Remote events, close Sessions/control/events streams and request bounded process termination
- **AND** official Native Session persistence SHALL remain available on the next DSH start

#### Scenario: Selection fails after spawning

- **WHEN** version-compatible DSH was spawned but readiness, authentication or capability validation fails
- **THEN** the failed selection SHALL close every resource it created and terminate only that ChildProcess
- **AND** a later explicit refresh SHALL start from an unowned clean state

### Requirement: CH-owned Modern DSH Web remains securely accessible

The settings page SHALL offer a localized Web-open action only while the local Adapter owns a running exact rc.1 Modern DSH process. The Renderer-visible capability and action response MUST contain no bootstrap URL, token or cookie; opening SHALL occur through the existing trusted local platform boundary.

#### Scenario: Local CH-owned Modern DSH is ready

- **WHEN** the local Host inspects a Modern Adapter whose owned process and validated bootstrap URL are still current
- **THEN** the settings page SHALL show an action to open DeepSeek Harness Web
- **AND** invoking it SHALL open the authenticated bootstrap URL without returning that URL or token to Renderer code

#### Scenario: DSH is not owned by this local Host

- **WHEN** the selected implementation is Legacy, the endpoint is externally owned, the Host is remote, the managed process has closed, or a stale open action fails
- **THEN** the settings page SHALL not expose an enabled Web-open action
- **AND** a direct or stale action request SHALL fail without opening any URL, invalidate the Renderer capability and trigger a fresh inspection

#### Scenario: Web-open action is repeated

- **WHEN** the user invokes the action more than once while the same owned process remains ready
- **THEN** each invocation MAY open the same validated bootstrap URL so DSH can establish a browser cookie and redirect to clean `/`
- **AND** no invocation SHALL persist or copy the token, emit it in diagnostics, or place it in long-lived DOM state
