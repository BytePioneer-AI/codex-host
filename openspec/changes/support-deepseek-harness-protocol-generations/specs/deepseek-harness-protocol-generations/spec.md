## ADDED Requirements

### Requirement: DeepSeek protocol generations SHALL have one public Adapter and isolated implementations

Host Runtime SHALL register one `deepseek-harness` Adapter. That Adapter SHALL select one protocol implementation before opening a Session and SHALL keep Legacy and Modern native types, clients, parsers, state machines, and tests isolated. No downstream Host, Protocol Core, Renderer, or Mapping Store component SHALL branch on DSH version.

#### Scenario: Concurrent inspection and open select one generation

- **WHEN** inspection and Session open concurrently reach an unselected DeepSeek Adapter
- **THEN** they SHALL share one bounded selection operation
- **AND** every accepted Session SHALL use the same selected implementation until Adapter close

#### Scenario: Selection fails transiently

- **WHEN** selection fails because a process or endpoint is temporarily unavailable
- **THEN** a later explicit refresh SHALL be able to retry
- **AND** no partial delegate, socket, timer or managed process SHALL remain owned invisibly

#### Scenario: Close races selection

- **WHEN** Adapter close begins during version detection, process startup or authentication
- **THEN** the selection SHALL be cancelled or drained within a bound
- **AND** only resources and ChildProcesses created by that selection SHALL be closed

### Requirement: Supported DSH releases SHALL be exact and evidence-backed

The integration SHALL support only Legacy `0.1.1-rc.2` and Modern `0.1.2-rc.1`. Semver ordering, source-level protocol boundaries, a placeholder Host version, executable lookup, or partial capability success MUST NOT add another release to the support set.

#### Scenario: Exact rc.1 passes the Modern handshake

- **WHEN** the managed local executable reports `0.1.2-rc.1` and its authenticated Web Remote satisfies every required schema and capability probe
- **THEN** the Adapter SHALL select the Modern implementation

#### Scenario: A protocol-equivalent alpha remains unsupported

- **WHEN** the executable reports `0.1.2-alpha.4`, `0.1.2-alpha.5` or another release not in the exact support set
- **THEN** the Adapter SHALL reject it before starting a Session even if earlier protocol probes found the same wire shape
- **AND** it SHALL NOT add a release-specific transport, parser, factory or Session branch

#### Scenario: Exact rc.2 Host passes the Legacy handshake

- **WHEN** the local executable reports `0.1.1-rc.2` or a loopback Host satisfies the complete exact rc.2 wire contract
- **THEN** the Adapter SHALL select the Legacy implementation
- **AND** that contract probe SHALL NOT advertise any other DSH release as supported

#### Scenario: Owned rc.2 Web listens before its routes are mounted

- **WHEN** codexhost has verified and started the exact rc.2 executable, and its owned Web temporarily returns HTTP 404 while mounting the required Legacy routes
- **THEN** the managed readiness probe MAY retry that response only within the startup deadline
- **AND** the same response from a pre-existing endpoint SHALL fail closed without starting or replacing a process

#### Scenario: Another prerelease is installed

- **WHEN** DSH reports a release other than `0.1.1-rc.2` or `0.1.2-rc.1`
- **THEN** inspection SHALL reject it before starting a Session or sending content
- **AND** the bilingual non-retryable error SHALL identify the installed release and recommend updating to `dsh-v0.1.2-rc.1` without exposing local secrets

### Requirement: Modern DSH SHALL use only a managed authenticated Web Remote

The Modern implementation SHALL start exact `0.1.2-rc.1` Web itself, exchange only that ChildProcess's validated loopback launch token for a matching session cookie, and communicate through authenticated HTTP Remote and Remote mux. The first release MUST NOT attach an already-running Modern Web or accept an externally supplied bootstrap URL.

#### Scenario: codexhost starts a supported Modern Web

- **WHEN** no compatible Legacy Host is attached and an exact `0.1.2-rc.1` executable is available
- **THEN** codexhost SHALL start Web on `127.0.0.1` with an OS-selected port, wait for its bounded readiness URL, exchange its token for a validated cookie, and verify required Remote methods before inspection becomes ready

#### Scenario: Target endpoint is an unauthenticated Modern Web

- **WHEN** a configured or default endpoint exactly matches the bounded unauthenticated Modern DSH 401 root fingerprint but was not started by this Adapter
- **THEN** the Adapter SHALL report authentication required and instruct the user in Chinese and English to close that DSH Web instance and rerun connection diagnostics
- **AND** it MUST NOT exchange an external token, read DSH credential storage, disable authentication, start a competing Web over the same home, or send Session content

#### Scenario: Adapter closes a managed Modern Host

- **WHEN** the Adapter that started a supported Modern Web closes or fails during startup
- **THEN** it SHALL close its streams and terminate only that exact ChildProcess within the configured TERM/KILL bounds
- **AND** stdout and stderr SHALL remain consumed until the process exits

### Requirement: Modern wire trust boundaries SHALL be strict, bounded and secret-free

Every readiness line, authentication response, unary response, WebSocket message, history page and interaction payload SHALL be validated against the exact Modern rc.1 grammar and a finite byte/item/work limit before use. Token, cookie, launch URL and authentication headers MUST NOT enter logs, diagnostics, snapshots, persistence or Renderer-visible contracts.

#### Scenario: Bootstrap exchange succeeds

- **WHEN** the managed process emits one valid root loopback URL with one token and the root responds with the expected manual 303 redirect and Host-only session cookie
- **THEN** subsequent HTTP and WebSocket operations SHALL use only the clean origin and matching cookie pair
- **AND** Remote transport operations after authentication SHALL use no tokenized URL

#### Scenario: A wire value exceeds its limit

- **WHEN** stdout, an HTTP body, a WebSocket frame, a history record or pagination work exceeds its documented finite limit
- **THEN** the affected selection or Session SHALL fail with a protocol error
- **AND** the Adapter MUST NOT truncate the wire value and continue interpreting it

#### Scenario: A logical stream omits its required opening frame

- **WHEN** the physical Remote stream opens but follow omits its snapshot, control omits its baseline, or `$events` omits its ready frame
- **THEN** the logical opening SHALL fail within a finite deadline
- **AND** the Adapter SHALL abort and return that stream without leaving a pending iterator read

#### Scenario: Diagnostic source contains credentials

- **WHEN** stdout/stderr or a transport failure contains the bootstrap URL, token, cookie, Cookie/Set-Cookie header or a common secret form
- **THEN** the structured diagnostic SHALL omit or redact the secret before publication
- **AND** a secret canary SHALL not appear in logs, errors, snapshots or copied diagnostics

### Requirement: Modern complete history SHALL combine follow, fixed-cut pages and buffered live events

The Modern implementation SHALL open `session/follow` before reading old history, treat its opening cursor as one immutable cut, page backwards with `session/page` and that exact `throughSeq` until `hasMore=false`, and buffer live events until the complete `0..cursor` journal has been validated and projected.

#### Scenario: Mapped supported Modern Session resumes with older pages

- **WHEN** the follow opening snapshot reports `hasMore=true`
- **THEN** the Adapter SHALL keep follow attached, page backwards from the same inclusive `throughSeq`, losslessly expand packed chunk records, and merge a gap-free full journal
- **AND** it SHALL apply buffered live events only from `cursor + 1` after the opening journal is committed

#### Scenario: Journal contains invalid continuity

- **WHEN** a page or live record skips, partially overlaps, repeats without an allowed overlap, reorders, makes no pagination progress, exceeds the work budget, or cannot decode a required event
- **THEN** the Session SHALL fault explicitly
- **AND** codexhost SHALL NOT fabricate history, silently reset the cursor or read DSH JSONL

#### Scenario: Follow transport reconnects

- **WHEN** the physical follow connection is replaced
- **THEN** the Adapter SHALL obtain a new opening snapshot and reconcile it with the last committed seq using follow/page facts
- **AND** it SHALL continue only when no gap or conflicting history exists

### Requirement: Modern live projection SHALL come from session control baseline and updates

The Modern implementation SHALL maintain an authenticated `session/control` stream. Each generation SHALL begin with one complete baseline and later projection updates SHALL be applied only when their seq is newer than the loaded Session's current watermark. Rows for Sessions not loaded from Mapping Store SHALL be discarded and SHALL NOT create Threads or persisted state.

#### Scenario: Session opens while control is already active

- **WHEN** follow opening projections and the control baseline both contain a loaded Session
- **THEN** the Adapter SHALL validate both values and retain the projection with the higher authoritative seq
- **AND** conflicting values at the same seq SHALL fault the Session

#### Scenario: Model selection succeeds after a stale update

- **WHEN** `session/selectModel` succeeds, a stale projection arrives, and a later higher-sequence projection confirms the requested Model/Thinking
- **THEN** the Adapter SHALL ignore the stale value and publish only the confirmed state

#### Scenario: Permission projection disagrees with inspection

- **WHEN** a loaded Session's `permissions` options/currentValue are malformed or disagree with the inspected native permission settings catalog
- **THEN** open, refresh or selection SHALL fail closed
- **AND** the requested Permission Mode SHALL NOT be published optimistically

### Requirement: Modern Turn identity SHALL be correlated by native requestId

A successful `session/prompt` SHALL acknowledge inbox admission only. The Adapter SHALL associate a Host Turn with a native Turn only after one of the native Turn's initial user messages carries the same client-minted requestId, buffering an earlier native `turn/start`, `step/start` and later events. It MUST inspect the whole initial user-message batch rather than classify on the first foreign source. A native Turn SHALL be projected as autonomous only after its initial user sources prove that none match a pending request, or after it reaches terminal state without a match; model-work events alone MUST NOT end correlation because Modern DSH emits `step/start` before the correlated user message. An uncertain prompt transport result MUST NOT be retried because rc.1 does not deduplicate requestId admission.

#### Scenario: Native turn starts before its user message

- **WHEN** follow emits `turn/start` before the user message whose source rpcId matches a pending Host Turn
- **THEN** the Adapter SHALL buffer the native events, bind the matching identities once, and publish them in native order
- **AND** it SHALL NOT misclassify the Turn as autonomous

#### Scenario: Autonomous turn races a Host prompt

- **WHEN** DSH starts an unrelated native Turn while a Host prompt admission is pending
- **THEN** the unrelated Turn SHALL retain its own autonomous Host identity
- **AND** the later requestId match SHALL bind only the requested Host Turn without overwriting either active identity

#### Scenario: An accepted prompt is removed before its durable user message

- **WHEN** DSH admits the requestId but pre-step rejects, clears or rewrites the claimed batch so the native Turn ends without a matching `user/message.source.rpcId`
- **THEN** inbox admission SHALL NOT clear the accepted-prompt correlation deadline
- **AND** expiry SHALL fail the Host Turn exactly once and fault the Session rather than resend, misbind an autonomous Turn or remain permanently busy

#### Scenario: Cancellation response races terminal history

- **WHEN** `session/cancel` is acknowledged before or after the authoritative native `turn/end`
- **THEN** the Host Turn SHALL complete exactly once from native state
- **AND** duplicate or late responses SHALL not create another terminal event

#### Scenario: Final reasoning revises streamed reasoning

- **WHEN** provisional `reasoning-delta` content differs from the authoritative final `assistant/message`, including a removed suffix or a middle rewrite
- **THEN** the Adapter SHALL publish the final reasoning once as the append-only Host Reasoning Item and complete it without faulting the Session
- **AND** ordinary assistant text SHALL remain streamed with its prefix invariant unless an independently verified rc.1 event disproves that contract
- **AND** the complete event SHALL be validated before any final Reasoning output; the accepted live-order limitation is defined by the `harness-reasoning-projection` delta

### Requirement: Modern controls SHALL use native operations and authoritative readback

Modern create, prompt, cancel, Model/Thinking selection, Permission selection, commands and Fork SHALL use the matching supported Modern Remote. Requested configuration MUST NOT be published until `session/control` or validated journal facts confirm it.

#### Scenario: Reviewed Harness command executes on Modern DSH

- **WHEN** a supported Modern release advertises a reviewed `compact`, `goal` or `plan` command and Host executes its CH command ID
- **THEN** the Adapter SHALL invoke `commands/execute` with the exact native line and required empty images field
- **AND** SHALL preserve the existing Harness Command lifecycle without converting it into ordinary prompt text

#### Scenario: Modern Permission selection is requested

- **WHEN** Host selects one inspected native Permission Mode
- **THEN** the Adapter SHALL execute only the reviewed internal `/permission` line and wait for a newer exact `permissions` projection
- **AND** command settlement text SHALL NOT be treated as state

#### Scenario: Modern Fork is requested at a completed Turn

- **WHEN** Host supplies a same-cwd checkpoint whose seq identifies native `turn/end`
- **THEN** the Adapter SHALL call `session/fork`, include native configuration events before the next `turn/start` in the expected prefix, and verify child identity, parent, cwd, seed marker and complete inherited journal
- **AND** a failed postcondition SHALL close without automatically retrying the non-idempotent Fork

#### Scenario: Fork boundary is inside the final configuration tail

- **WHEN** the requested `atSeq` is after the final `turn/end` but not after the journal tail
- **THEN** the Adapter SHALL preserve the supported Modern release's fork-unavailable result
- **AND** it MUST NOT silently fall back to the previous completed Turn

### Requirement: Modern interactions SHALL respect Remote Event client ownership and replacement

The Modern implementation SHALL consume only valid loaded-Session `approval/request` and `user-questions/request` waterfalls from an established `$events` generation. It SHALL return `next` for unowned or unhandled valid requests, map claimed requests to standard Host interactions, and settle the exact event once through `$events/result`.

#### Scenario: Another Client can answer

- **WHEN** CH receives a valid waterfall for an unloaded agentId or an event it does not own
- **THEN** it SHALL submit `outcome: next`
- **AND** it MUST NOT reject, auto-approve or otherwise cancel another Client's opportunity to answer

#### Scenario: Pending event is replayed after reconnect

- **WHEN** a replacement `$events` generation replays the same pending eventId with a new clientId
- **THEN** CH SHALL rebind the existing Host interaction to the new generation without publishing a duplicate
- **AND** a response carrying the old clientId, a duplicate replay or a later cancel SHALL be idempotent

#### Scenario: User answers a Modern question

- **WHEN** Host returns a valid answer for a claimed DSH question
- **THEN** the Adapter SHALL submit the structured answer to the same current client/event generation exactly once
- **AND** later cancellation or duplicate Host responses SHALL NOT invoke DSH again

#### Scenario: Session detaches with a pending interaction

- **WHEN** Session or Adapter close begins while CH has a current Remote Event delivery
- **THEN** CH SHALL submit `next` before closing the local interaction
- **AND** an unrecoverable unexpected disconnect SHALL best-effort cancel the native Turn before faulting rather than leave a known pending wait indefinitely

### Requirement: Legacy behavior SHALL remain independently verifiable

Moving the exact rc.2 Host ApiProxy implementation behind generation selection SHALL preserve all behavior already covered by Legacy tests, including history/resume, Model/Thinking, Permission, Approval/Question, Usage, commands, cancellation, autonomous Turns and same-cwd Fork.

#### Scenario: Supported Legacy DSH is selected

- **WHEN** the selector verifies the exact rc.2 Host contract
- **THEN** existing DeepSeek Threads and new Turns SHALL behave as before the protocol-generation refactor
- **AND** no Modern authentication, Remote stream or event type SHALL enter the Legacy implementation
