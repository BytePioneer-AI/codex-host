## MODIFIED Requirements

### Requirement: Local DSH Web profile is the runtime source of truth

The DeepSeek Harness Adapter SHALL use a managed authenticated loopback Web Remote started from the user's local DSH Web profile, and SHALL start it only for executables at or above `0.1.7-rc.1`. The verified list SHALL contain only versions whose native lifecycle Gates pass, currently `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, and `0.2.0-rc.2`; other normative SemVer versions at or above the minimum MUST pass the V4 native protocol checks before being reported ready. codexhost MUST NOT substitute a private Cordis composition, credentials provider, Skill catalog, or Native Session store, and MUST NOT attach through the retired Legacy Host protocol.

#### Scenario: Supported DSH Web is already running externally
- **WHEN** the configured loopback endpoint exposes the recognized unauthenticated DSH Web fingerprint
- **THEN** the Adapter SHALL report missing authentication and instruct the user to close that instance and retry diagnostics
- **AND** it MUST NOT reuse unknown credentials or stop the external process

#### Scenario: DSH Web is not running
- **WHEN** a local command reporting a normative SemVer version at or above `0.1.7-rc.1` is available
- **THEN** codexhost SHALL start `web --no-open --host 127.0.0.1 --port 0`, authenticate its managed Web and wait a bounded time
- **AND** it SHALL validate the V4 native protocol before reporting ready

#### Scenario: Installed DSH is older than the V4 line
- **WHEN** the local command reports a normative SemVer version below `0.1.7-rc.1`
- **THEN** codexhost SHALL NOT start DSH Web and SHALL report `unsupported` with the minimum version and an upgrade command
- **AND** it MUST NOT upgrade the CLI or modify native Sessions

#### Scenario: Endpoint belongs to another service
- **WHEN** the configured endpoint responds without the recognized DSH fingerprint
- **THEN** the Adapter MUST NOT terminate, replace, attach to, or send Session content to that service
- **AND** any supported managed Web SHALL use its own ephemeral loopback port

### Requirement: Public history and live events are authoritative

The Adapter SHALL build Snapshot and live Harness outputs only from the official DSH Web Remote history and event APIs. It SHALL preserve native order and V4 format semantics for each Session; a Session created by an older DSH release SHALL be read only after DSH itself migrates it to V4.

#### Scenario: Mapped Session resumes after application restart
- **WHEN** Host opens a valid mapped DeepSeek Native Session reference
- **THEN** the Adapter SHALL read its public native history through the V4 profile and return a standard Snapshot
- **AND** a later Turn SHALL continue the same Native Session

#### Scenario: Live stream disconnects
- **WHEN** a DSH event connection is interrupted
- **THEN** the Adapter SHALL perform bounded supported recovery or explicitly fault the Session
- **AND** recovery SHALL use public history and the matching assistant baseline without reading native JSONL files

#### Scenario: DSH migrates a Session to V4
- **WHEN** a supported CLI opens a mapped or imported native Session that an older DSH created in V0 or V3
- **THEN** the Adapter SHALL read and validate the migrated V4 history without performing its own file migration
- **AND** any pre-migration checkpoint SHALL NOT authorize a mutating Fork or rollback

### Requirement: DSH Permission Modes remain dynamically provider-owned
The Adapter SHALL discover the selectable Permission Mode catalog from the process-level V4 `permissionPresets/catalog` Remote, and SHALL read each Session's effective mode from the authoritative `permissions` projection. It MUST NOT hardcode preset IDs, order, labels, descriptions, or defaults, parse command settlement text as state, or substitute Agent composition presets.

#### Scenario: V4 composes no permission presets
- **WHEN** the V4 catalog Remote reports `gateway/service-unavailable`
- **THEN** the Adapter SHALL report `selectPermissionMode=false` and omit the catalog
- **AND** any other catalog failure SHALL fail inspection closed

#### Scenario: V4 current value is outside the inspected catalog
- **WHEN** a V4 `permissions` projection reports `custom` or the reserved `auto` preset that a live integration published after inspection
- **THEN** the Adapter SHALL publish it as the current value without making it selectable
- **AND** any other unknown value SHALL fail closed

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

#### Scenario: DSH asks a timed user question
- **WHEN** a DSH preset enables timed `ask_user_question` and the question request carries a `wait` descriptor
- **THEN** the Adapter SHALL expose the question through the standard interaction without claiming the native wait or setting an expiry
- **AND** when DSH releases the wait at its deadline while the same Host Turn continues, the Adapter SHALL keep the interaction open until the native tool result for that call settles it or the Host Turn ends

#### Scenario: User answers a timed question after its wait was released
- **WHEN** the native tool result for an open timed question records the pending payload and the user answers before the Host Turn completes
- **THEN** the Adapter SHALL deliver the answer through the native `userQuestions/answer` Remote and close the interaction as responded when DSH accepts it
- **AND** a reply DSH declines SHALL close the interaction as superseded without fabricating an answer, and skipping SHALL close it without writing a native reply

#### Scenario: User answers a timed question while its native result is unknown
- **WHEN** the user answers a timed question after DSH released its wait, or in time as DSH releases it, before the native tool result for that call is recorded
- **THEN** the Adapter SHALL keep the interaction open and SHALL NOT acknowledge the answer until that result arrives
- **AND** it SHALL deliver the answer through `userQuestions/answer` only if the result records the pending payload, and SHALL report that delivery as for a continued question
- **AND** when the result records DSH accepting the in-time answer it SHALL close the interaction as responded, and when the call was answered elsewhere it SHALL close the interaction as superseded and return an error
- **AND** when the result records a failure, including after an in-time answer, it SHALL close the interaction as cancelled and return an error
- **AND** a Session fault or close SHALL end the wait without delivering the answer

#### Scenario: Host Turn ends with a continued timed question
- **WHEN** the Host Turn completes while a continued timed question is still open
- **THEN** the Adapter SHALL close the interaction as expired before completing the Turn
- **AND** it SHALL NOT accept a late answer across Turns or recreate the question when the Session resumes

#### Scenario: Native cancellation is accepted
- **WHEN** codexhost cancels an active DeepSeek Turn and the Host accepts `session.cancel`
- **THEN** the Adapter SHALL accept cancellation and complete the Turn exactly once from authoritative native state
