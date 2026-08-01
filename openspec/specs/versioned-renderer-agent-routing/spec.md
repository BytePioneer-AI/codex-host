# versioned-renderer-agent-routing Specification

## Purpose

Define the supported Desktop build contract for Composer-scoped Codex/Pi routing, native create-state adaptation, title isolation, lazy Pi Session ownership, and privacy-preserving end-to-end validation.
## Requirements
### Requirement: Composer Agent freezes at submission

The Renderer Extension SHALL keep Agent state isolated by logical Composer, SHALL keep the selected Agent mutable while the user edits a draft, SHALL synchronously freeze the final Agent when that draft is submitted, and SHALL remember the Agent of the most recently submitted Composer for later new-Thread drafts in the same Renderer process.

#### Scenario: User switches after editing

- **WHEN** a user types, pastes, composes with an IME, deletes content, inserts an attachment, or adds a line break before submission
- **THEN** the Composer remains in the draft phase and the user can still select Codex or Pi

#### Scenario: Agent switch invalidates stale prewarm

- **WHEN** a draft Composer selects a different Agent
- **THEN** the Renderer first applies that Agent's optimistic Model state and then calls the official `clear-prewarmed-threads-for-host` operation for the uniquely owned local host

#### Scenario: Submission freezes the final Agent

- **WHEN** the user clicks Send, presses Enter without Shift or active IME composition, or submits the Composer form
- **THEN** the Renderer synchronously reapplies the final Agent, locks the Composer, records that Agent as the most recently submitted Agent, and records one deduplicated submission before Desktop creates or consumes the submitted Thread

#### Scenario: First creation replaces the Composer DOM

- **WHEN** a draft or locked new-Thread Composer transitions from its opaque `default` Model target to a `conversation` target
- **THEN** the replacement Composer retains the same logical Composer identity, selected Agent, and phase

#### Scenario: User opens a new Thread

- **WHEN** a conversation Composer is replaced by a new default Composer
- **THEN** the new Composer starts in draft phase with the Agent used by the most recently submitted Composer in the same Renderer process
- **AND** it starts as Codex when no Composer has been submitted in that Renderer process

#### Scenario: User only opens an existing Thread

- **WHEN** the user opens or revisits a Thread without submitting a Turn
- **THEN** that Thread's Agent does not replace the most recently submitted Agent used for later new-Thread drafts

#### Scenario: User revisits a submitted Thread

- **WHEN** a submitted conversation Composer is unmounted and an equivalent opaque conversation Model target is mounted again in the same Renderer process
- **THEN** the Renderer restores that logical Composer's identity, final Agent, and locked phase
- **AND** it does not interpret, serialize, or persist the opaque target's Thread identity

#### Scenario: Switch is in flight

- **WHEN** the official prewarm clear has not settled
- **THEN** Agent controls and submission are disabled for that Composer

#### Scenario: Switch fails

- **WHEN** prewarm clearing fails
- **THEN** the Renderer restores the prior Agent; if restoration also fails, the Adapter becomes unsupported and submission fails closed

#### Scenario: User attempts to switch after submission

- **WHEN** a Composer Agent is locked
- **THEN** the Agent controls are disabled and selecting another Agent requires a new Thread

### Requirement: Versioned Adapter drives the native create Model state
For a supported Desktop build, the Renderer Adapter SHALL synchronously update the uniquely associated Composer's optimistic native Model state to a bounded internal Pi transport carrier only when that Composer selects Pi. The generic carrier SHALL be `codexhost/pi-native`; an explicit selected Pi Model SHALL be represented by the same carrier plus an opaque Harness Model Ref and SHALL remain internal rather than user-visible.

#### Scenario: Pi conversation create
- **WHEN** a supported Adapter observes the unique Pi Composer without an explicit Pi Model Ref before native creation
- **THEN** the native conversation `thread/start` carries `codexhost/pi-native` as its internal Model transport token

#### Scenario: Pi conversation create with selected Model
- **WHEN** a supported Pi Composer has selected a valid Pi Model Ref before native creation
- **THEN** the native conversation `thread/start` carries the bounded selected Pi transport carrier for that exact Composer
- **AND** the displayed Model remains the normalized Pi catalog label rather than the carrier

#### Scenario: Codex conversation create
- **WHEN** the Composer selects Codex
- **THEN** the Adapter restores the captured opaque official state and the native create retains official Model behavior

#### Scenario: Unsupported or ambiguous Renderer
- **WHEN** the asset, atom pair, Model target, installation timing, or Composer association is unsupported or ambiguous
- **THEN** Pi creation is blocked with an explicit unavailable state and no request is silently routed to Codex

#### Scenario: Official prewarm bridge is unavailable
- **WHEN** the version-locked Adapter cannot uniquely recover the owned official request bridge or its signature is unsupported
- **THEN** draft Agent switching is unavailable and no generic Desktop request capability is exposed to the Renderer Extension

#### Scenario: Model control request manager is unavailable
- **WHEN** Agent routing remains supported but the Adapter cannot uniquely recover the active request manager needed for fixed Model controls
- **THEN** Pi Model inspection and immediate selection are unavailable
- **AND** the Adapter does not expose or call a generic request method

#### Scenario: Transport state is temporary
- **WHEN** Pi is selected and later a new Codex Composer is mounted
- **THEN** the Adapter restores the opaque pre-Pi state without calling the official persistent Model setter or persisting any Pi transport carrier as the user default Model

### Requirement: Pi title generation does not enter Codex Harness

The versioned main-process policy SHALL bind each supported metadata generation service to its owning Renderer window and SHALL prevent a locked Pi Composer from creating an official Codex title Thread.

#### Scenario: Pi first Turn requests an automatic title

- **WHEN** the owning Renderer reports one uniquely locked Pi Composer
- **THEN** title generation returns no remote title and Codex Desktop uses its existing local fallback without an official ephemeral `thread/start`

#### Scenario: Codex first Turn requests an automatic title

- **WHEN** the owning Renderer reports one uniquely locked Codex Composer
- **THEN** the original official title service behavior is preserved

#### Scenario: Pi fallback title is stored

- **WHEN** Desktop applies its local fallback through `thread/name/set` for a Pi-owned Thread
- **THEN** the Host updates the Pi Thread and emits `thread/name/updated` locally without forwarding the request to Codex

#### Scenario: Title ownership is ambiguous

- **WHEN** the service owner, Probe, or locked Composer cannot be determined uniquely
- **THEN** remote title generation is skipped rather than sending potentially Pi-owned content to Codex

### Requirement: Prewarm ownership does not create unused Pi processes

The Host SHALL establish Pi Thread ownership at `thread/start` and SHALL defer `PiRpcSession` startup until the first `turn/start` for that exact Thread ID.

#### Scenario: Multiple prewarm Threads

- **WHEN** one Composer interaction creates multiple Pi prewarm Threads and only one receives `turn/start`
- **THEN** only the consumed Thread starts a Pi Native Session

#### Scenario: Continued Pi Thread

- **WHEN** a later Turn starts for a consumed Pi Thread
- **THEN** the Host reuses the same Pi Native Session

#### Scenario: Desktop clears an unused Pi prewarm

- **WHEN** official prewarm invalidation sends `thread/delete` for a Pi-owned Thread
- **THEN** the Host closes and removes that Thread locally, forgets its anonymous create association, and returns success without forwarding the request to Codex

#### Scenario: Host closes with unused prewarms

- **WHEN** the Host closes while Pi prewarm Threads were never consumed
- **THEN** no Pi child processes exist for those unused Threads

### Requirement: Controlled validation proves end-to-end routing

The controlled Gate SHALL associate sanitized create and Turn observations before claiming a real Pi route.

#### Scenario: Transport-only verification

- **WHEN** Codex and Pi Composers trigger conversation `thread/start` calls
- **THEN** Host observations classify Codex creates as `official-model` and Pi creates as `pi-transport`

#### Scenario: Sanitized Thread association

- **WHEN** a create response and later `turn/start` refer to the same Thread
- **THEN** the observation records a matched anonymous create ordinal, selected Harness, and non-sensitive Thread purpose without recording the Thread ID

#### Scenario: Real Pi verification

- **WHEN** transport verification passes and a Pi-selected Composer submits its first Turn
- **THEN** the Host selects Pi, starts one Pi Native Session, and projects the Pi response into the same Codex Thread

#### Scenario: Pi continuation verification

- **WHEN** the same Pi Thread submits a later Turn
- **THEN** no new `thread/start` occurs and the existing Pi Native Session is reused

#### Scenario: Bidirectional draft switching verification

- **WHEN** controlled runs switch Codex to Pi and Pi to Codex after a prewarm exists
- **THEN** the submitted Turn matches the newly created final-Agent ordinal, the stale ordinal remains unconsumed, and stale Pi deletion does not reach Codex

#### Scenario: Repeated draft switching verification

- **WHEN** one draft switches Pi to Codex to Pi before submission
- **THEN** the final Turn selects Pi, no stale prewarm starts a Pi process, and the transport token remains absent from the persisted Codex configuration

#### Scenario: Diagnostic privacy

- **WHEN** the Gate records Renderer, Host, title policy, and Session evidence
- **THEN** it omits Prompt text, input values, Transcript, full DOM, Model values, and complete request or Thread IDs

### Requirement: Development configuration can enable registered Claude routing
The versioned Renderer Agent control SHALL use an explicit enabled-Agent list. Its default list SHALL remain Codex and Pi, and a controlled development configuration MAY add Claude Code without introducing another request hook or bypassing the existing Composer state machine.

#### Scenario: Default Renderer Probe installs
- **WHEN** no Claude development configuration is present
- **THEN** the Agent control SHALL contain only Codex and Pi
- **AND** existing Pi transport selection and Codex restoration SHALL remain unchanged

#### Scenario: Controlled Probe enables Claude
- **WHEN** the controlled Gate sets the validated Claude development flag before installing the Probe
- **THEN** the same Agent control SHALL add a `Claude Code` option
- **AND** selecting it SHALL use the same draft switch, prewarm clear, submit freeze, replacement transfer, and revisit restoration logic

#### Scenario: Claude create is submitted
- **WHEN** a locked Claude Composer creates a Thread on a supported Renderer build
- **THEN** the existing optimistic Model atom SHALL carry `codexhost/claude-code-native`
- **AND** no shared request object or official persistent Model default SHALL be modified

#### Scenario: Disabled Agent is requested
- **WHEN** code attempts to select an Agent absent from the enabled list
- **THEN** the Renderer SHALL reject the switch and remain on the prior Agent

### Requirement: External Agent title isolation is shared
The main-process title policy SHALL call the official title service only for a uniquely locked Codex Composer. Pi, Claude Code, unknown external Agents, and ambiguous ownership SHALL return the existing local fallback without reading or forwarding Prompt content.

#### Scenario: Claude first Turn requests a title
- **WHEN** the owning Renderer reports one locked Claude Code Composer
- **THEN** title generation SHALL skip the official Codex Harness and use local fallback

#### Scenario: Codex first Turn requests a title
- **WHEN** the owning Renderer reports one locked Codex Composer
- **THEN** original official title generation SHALL remain unchanged

### Requirement: Controlled Renderer evidence recognizes Claude without exposing content
Renderer binding tooling SHALL require an explicit CLI option to enable Claude and SHALL accept only known Agent enum values in sanitized observations.

#### Scenario: Claude Gate observes submission
- **WHEN** a user selects Claude Code and submits in the controlled Renderer
- **THEN** the report SHALL record only Agent enum, anonymous Composer identity, phase, trigger, and transport decoration counts
- **AND** it SHALL omit Prompt, Model value, full DOM, request ID, Thread ID, and Transcript

### Requirement: Pi Model state follows the logical Composer lifecycle
The Renderer SHALL keep the selected Pi Model Ref and asynchronous Model-control state scoped to the same logical Composer identity used for Agent routing while allowing Model selection for an existing Pi Thread only through its validated current-process Thread identity.

#### Scenario: Draft replacement retains Model
- **WHEN** a Pi draft or locked new-Thread Composer transitions from its opaque default target to the created conversation target
- **THEN** the replacement retains the selected Pi Model Ref and control state

#### Scenario: Same-process conversation revisit
- **WHEN** an equivalent opaque conversation target is revisited in the same Renderer process
- **THEN** the Renderer restores the final Pi Model Ref without persisting or logging the Thread identity

#### Scenario: New task resets Model
- **WHEN** a conversation target transitions to a new default Composer
- **THEN** the new Composer uses the most recently submitted Agent without inheriting the prior Composer's Pi Model Ref

#### Scenario: Existing Pi Thread selection
- **WHEN** the supported conversation target yields one validated current-process Host Thread ID and the user selects a different Pi Model
- **THEN** Renderer sends the fixed Thread Model-selection request and applies only the confirmed effective Ref returned from Host state observation

#### Scenario: Stale asynchronous result
- **WHEN** an earlier inspection or selection resolves after the logical Composer, Agent, target, or request generation changed
- **THEN** Renderer ignores that result and preserves the newer state

### Requirement: Supported sidebar rows show immutable external Agent ownership
For a supported Desktop build, Renderer Extension SHALL recover each mounted sidebar row's Host Thread ID only from a bounded React Fiber chain where one or more equal `conversationId` props have `dataAttributes` matching that exact DOM row's task-key, host, and row-marker attributes. It SHALL NOT treat the opaque sidebar task key as a Host Thread ID. Renderer SHALL batch validated Host Thread IDs through the fixed ownership-list client and render a compact title-prefix icon for a known external Agent. Codex rows SHALL remain unchanged, and sidebar decoration SHALL NOT alter Thread routing, selection, rename, status, pin, archive, hover, or action behavior.

#### Scenario: Pi and Claude Code rows are mounted
- **WHEN** mounted sidebar rows belong to Pi and development-gated Claude Code Threads
- **THEN** Renderer SHALL display the reviewed Pi and Claude Code icons before their respective titles
- **AND** each icon SHALL provide the Agent label without intercepting pointer input

#### Scenario: Codex row is mounted
- **WHEN** Host reports Codex ownership for a mounted sidebar row
- **THEN** Renderer SHALL leave the row undecorated

#### Scenario: Ownership lookup is unavailable or malformed
- **WHEN** the row/Fiber association is missing or ambiguous, the fixed request manager is unavailable, Host rejects the request, the response does not exactly match requested IDs, or the Harness has no known icon
- **THEN** Renderer SHALL leave affected rows undecorated and SHALL NOT infer ownership from title, Model Provider, Subagent fields, ordering, or timing

### Requirement: Sidebar ownership decoration survives virtualized row lifecycle
Renderer SHALL cache successful immutable ownership by Host Thread ID, coalesce DOM scans, and revalidate row connectivity plus its exact DOM/Fiber-derived Host Thread ID before applying asynchronous results. It SHALL remove or replace owned decoration when React replaces title content, recycles a row for another Thread, or the extension is disposed.

#### Scenario: Row is reused before ownership resolves
- **WHEN** a mounted row changes from one Thread ID to another before the earlier ownership request completes
- **THEN** Renderer SHALL NOT apply the earlier Thread's Agent icon to the reused row

#### Scenario: React replaces the row title DOM
- **WHEN** an externally owned row remains mounted but its title subtree is replaced
- **THEN** Renderer SHALL restore exactly one matching Agent icon from cached ownership

#### Scenario: Renderer Extension is disposed
- **WHEN** the Renderer Binding Probe is disposed
- **THEN** it SHALL disconnect sidebar observation, remove owned Agent icons, and ignore pending ownership results

### Requirement: Fork-created conversations recover immutable Agent ownership
When the supported Renderer mounts a conversation target that did not come from the current draft replacement, it SHALL query a fixed Host Thread inspection operation. A mapped external Thread SHALL initialize as that Harness and locked; an official Thread SHALL initialize as Codex without exposing Native identity.

#### Scenario: Forked Pi conversation mounts
- **WHEN** Codex Desktop navigates to the new Thread returned by an external Pi Fork
- **THEN** Renderer SHALL show Pi as selected and locked
- **AND** later submission SHALL retain Pi ownership regardless of another draft's Agent state

#### Scenario: Official Fork conversation mounts
- **WHEN** Host inspection identifies no external ownership
- **THEN** Renderer SHALL preserve Codex selection and official Model behavior

### Requirement: Forked Pi Model uses Host-confirmed state
Thread inspection SHALL return the bounded transport carrier and optional effective Harness Model for the exact Host Thread. Renderer SHALL apply only that confirmed state to the forked conversation and SHALL keep Agent and Model semantics separate.

#### Scenario: Pi Fork inherited an earlier Model
- **WHEN** the selected Checkpoint predates a later source Model change
- **THEN** the forked Composer SHALL display and carry the Model reported by the derived Pi Session rather than the source page's latest Model

### Requirement: Ownership restoration fails closed
Renderer SHALL generation-scope Thread inspection by logical Composer and target. While an unknown conversation may be external, submission SHALL remain blocked until ownership is resolved; stale, malformed, unavailable, or mismatched results SHALL not overwrite a newer target or silently select Codex.

#### Scenario: Inspection resolves after navigation
- **WHEN** a prior conversation inspection returns after another target is mounted
- **THEN** Renderer SHALL ignore that result

#### Scenario: External ownership inspection fails
- **WHEN** Host or the fixed request manager cannot safely resolve a forked external Thread
- **THEN** Renderer SHALL show an unavailable locked state and block submission rather than apply an official Model

### Requirement: Renderer does not replace the native Fork action
The external Fork feature SHALL reuse Codex Desktop's existing message action and its native protocol sequence, including an unbounded `thread/fork` followed by `thread/rollback` when emitted by the supported build. Renderer Extension MUST NOT add another Fork button, copy visible Transcript content, intercept rollback, or correlate Fork by timing.

#### Scenario: User clicks the native message Fork action
- **WHEN** Desktop issues its Fork and optional rollback requests for an external source
- **THEN** Renderer SHALL rely on the final returned conversation target and fixed ownership inspection without a DOM click hook
