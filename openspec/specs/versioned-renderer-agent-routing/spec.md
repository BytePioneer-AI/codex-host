# versioned-renderer-agent-routing Specification

## Purpose

Define the supported Desktop build contract for Composer-scoped Codex, Pi, and Claude Code routing, native create-state adaptation, title isolation, lazy external Session ownership, and privacy-preserving end-to-end validation.
## Requirements
### Requirement: Composer Agent freezes at submission

The Renderer Extension SHALL keep Agent state isolated by logical Composer, SHALL keep the selected Agent mutable while the user edits a draft, SHALL synchronously freeze the final Agent when that draft is submitted, and SHALL persist the Agent of the most recently submitted Composer for later new-Thread drafts across codexhost Renderer windows.

#### Scenario: Ordinary Chat composer is present

- **WHEN** the Renderer contains an editable form with a Send button outside a verified Codex composer root
- **THEN** the Renderer Extension does not mount Agent controls or intercept that form's input and submission events

#### Scenario: Renderer switches from Work to Chat

- **WHEN** a previously mounted Composer is no longer inside a verified Codex composer root
- **THEN** the Renderer Extension removes its controls and stops intercepting that Composer's input and submission events
- **AND** a later verified Codex composer is discovered normally without reloading the Renderer

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

- **WHEN** a submitted and locked new-Thread Composer transitions from its opaque `default` Model target to a `conversation` target
- **THEN** the replacement Composer retains the same logical Composer identity, selected Agent, and locked phase

#### Scenario: User opens a new Thread

- **WHEN** a conversation Composer is replaced by a new default Composer
- **THEN** the new Composer starts in draft phase with the valid persisted Agent used by the most recently submitted Composer in a codexhost Renderer window
- **AND** it uses the configured default, normally Codex, when no valid preference exists

#### Scenario: User only opens an existing Thread

- **WHEN** an unsubmitted default Composer transitions to a conversation because the user opens or revisits an existing Thread
- **THEN** the Renderer does not transfer the default Composer's Agent or configuration to that conversation
- **AND** it resolves and locks the conversation's immutable Agent through fixed Host ownership inspection
- **AND** that Thread's Agent does not replace the most recently submitted Agent used for later new-Thread drafts

#### Scenario: One mounted Composer changes between existing Threads

- **WHEN** Desktop reuses the same Composer DOM while its opaque conversation target changes from Thread A to Thread B
- **THEN** the Renderer immediately invalidates Thread A's pending ownership and Model requests and blocks submission while inspecting Thread B
- **AND** no Agent, Model, Thinking, or Permission state from Thread A is transferred to Thread B

#### Scenario: Rebound Thread belongs to Codex

- **WHEN** ownership inspection identifies Thread B as an existing Codex Thread
- **THEN** the Renderer locks it as Codex without writing its native Model state or calling an official Model setter
- **AND** its existing Codex Model and Thinking selection remain controlled only by Codex and explicit user action

#### Scenario: Rebound Thread belongs to an external Harness

- **WHEN** ownership inspection identifies Thread B as an existing external Thread
- **THEN** the Renderer restores only Thread B's confirmed Model, Thinking, and Permission state returned by Host
- **AND** it SHALL NOT represent that restored configuration by writing a transport carrier into the native Codex Model state

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

#### Scenario: Existing Codex Thread is prepared for input
- **WHEN** a locked existing Codex Thread receives input or submission events
- **THEN** the Renderer forwards the native Codex flow without writing any native Model state

#### Scenario: Existing external Thread continues
- **WHEN** a locked existing Pi or Claude Code Thread receives input or submission events
- **THEN** the Renderer SHALL NOT write a transport carrier into the native Codex Model state
- **AND** Host routes the Turn from immutable Thread ownership and retains configuration from the Native Session
- **AND** explicit Model, Thinking, or Permission changes use only the fixed Host control methods

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

### Requirement: Production configuration enables registered Claude routing
The versioned Renderer Agent control SHALL use an explicit enabled-Agent list containing Codex, Pi, and Claude Code. Claude Code SHALL use the same Composer state machine and SHALL support an optional Composer-scoped Claude Model Ref without introducing another request hook or bypassing submit freeze and prewarm invalidation.

#### Scenario: Default Renderer installs
- **WHEN** the production Renderer installs
- **THEN** the Agent control SHALL contain Codex, Pi, and Claude Code
- **AND** existing Pi transport selection and Codex restoration SHALL remain unchanged

#### Scenario: Controlled Probe verifies Claude
- **WHEN** the controlled Gate selects Claude Code before installing the Probe
- **THEN** the same Agent control SHALL retain the `Claude Code` option
- **AND** selecting it SHALL use the same draft switch, prewarm clear, submit freeze, replacement transfer, and revisit restoration logic

#### Scenario: Renderer configuration excludes Claude
- **WHEN** Claude Code is absent from the explicit enabled-Agent list
- **THEN** the Agent control omits Claude Code
- **AND** existing Pi transport selection and Codex restoration remain unchanged

#### Scenario: Renderer configuration enables Claude
- **WHEN** the validated enabled-Agent list includes Claude Code
- **THEN** the same Agent control adds a `Claude Code` option
- **AND** selecting it uses the same draft switch, prewarm clear, submit freeze, replacement transfer, and revisit restoration logic

#### Scenario: Claude create is submitted
- **WHEN** a locked Claude Composer creates a Thread on a supported Renderer build
- **THEN** the existing optimistic Model atom SHALL carry `codexhost/claude-code-native` or its bounded selected-Model form
- **AND** no shared request object or official persistent Model default SHALL be modified

#### Scenario: Claude create uses native default
- **WHEN** a locked Claude Composer without an explicit selected Ref creates a Thread on a supported Renderer build
- **THEN** the optimistic Model atom carries `codexhost/claude-code-native`
- **AND** no shared request object or official persistent Model default is modified

#### Scenario: Claude create uses selected Model
- **WHEN** a locked Claude Composer has one validated Claude Model Ref before creation
- **THEN** the optimistic Model atom carries the bounded Claude transport carrier containing that exact Ref
- **AND** the user sees the normalized Catalog label rather than the carrier or opaque Ref

#### Scenario: Disabled Agent is requested
- **WHEN** code attempts to select an Agent absent from the enabled list
- **THEN** Renderer rejects the switch and remains on the prior Agent

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

#### Scenario: Submitted Pi creation retains Model
- **WHEN** a submitted and locked Pi new-Thread Composer transitions from its opaque default target to the created conversation target
- **THEN** the replacement retains the selected Pi Model Ref and control state

#### Scenario: Same-process conversation revisit
- **WHEN** an equivalent opaque conversation target is revisited in the same Renderer process
- **THEN** the Renderer restores the final Pi Model Ref without persisting or logging the Thread identity

#### Scenario: New task uses the Pi preference
- **WHEN** a conversation target transitions to a new default Composer and Pi is selected
- **THEN** the new Composer initializes from the most recent valid Pi Model and Thinking preference
- **AND** it does not inherit uncommitted Model state from the prior Composer

#### Scenario: Existing Pi Thread selection
- **WHEN** the supported conversation target yields one validated current-process Host Thread ID and the user selects a different Pi Model
- **THEN** Renderer sends the fixed Thread Model-selection request and applies only the confirmed effective Ref returned from Host state observation

#### Scenario: Stale asynchronous result
- **WHEN** an earlier inspection or selection resolves after the logical Composer, Agent, target, or request generation changed
- **THEN** Renderer ignores that result and preserves the newer state

### Requirement: Sidebar Agent decoration converges from draft intent to persisted ownership
For a supported Desktop build, Renderer Extension SHALL decorate a mounted sidebar row from the earliest authoritative Agent source available for that row. An exact mounted default Composer match SHALL provide the selected local draft Agent before an external Mapping Store record is observable. An exact transferred or Host-confirmed conversation Composer MAY provide the same process-local Agent after creation. For rows without a matching logical Composer, Renderer SHALL use the fixed ownership-list client and persisted Host ownership.

Renderer MAY normalize an opaque `client-new-thread` sidebar task key only to correlate that row with the exact default Composer Model target. It MUST NOT treat that task key as a Host Thread ID, send it to Host, persist it, or infer an Agent from its contents. A Host Thread ID SHALL still be accepted only from a bounded React Fiber chain where one or more equal `conversationId` props have `dataAttributes` matching that exact DOM row's task-key, host, and row-marker attributes.

When a local Agent and a validated Host Thread ID become associated, Renderer MAY seed its process-local sidebar ownership cache so the icon survives Composer replacement or navigation. Persisted Host ownership remains authoritative for unmatched, restored, and later-process conversations. Sidebar decoration SHALL NOT alter Thread routing, selection, rename, status, pin, archive, hover, or action behavior.

#### Scenario: External draft appears before its Mapping Store record
- **WHEN** a mounted `client-new-thread` row exactly matches a default Composer whose selected Agent is a known external Agent
- **THEN** Renderer SHALL display that Agent's title-prefix icon without waiting for ownership-list success
- **AND** it SHALL NOT send the draft task key to Host

#### Scenario: External draft becomes a conversation
- **WHEN** the logical external Composer transfers from its default target to a validated conversation target
- **THEN** the row SHALL retain the same Agent icon
- **AND** the validated Host Thread ID MAY retain that ownership in the process-local sidebar cache after the Composer is replaced

#### Scenario: Existing external rows have no matching Composer
- **WHEN** mounted sidebar rows resolve validated Host Thread IDs whose persisted ownership belongs to known external Agents
- **THEN** Renderer SHALL display each reviewed Agent icon before its corresponding title
- **AND** each icon SHALL provide the Agent label without intercepting pointer input

#### Scenario: No safe Agent source is available
- **WHEN** local draft correlation is absent or ambiguous and the row/Fiber association, fixed request manager, Host response, or Harness icon is unavailable or malformed
- **THEN** Renderer SHALL leave the affected row undecorated
- **AND** it SHALL NOT infer ownership from title, Model Provider, Subagent fields, ordering, task-key contents, or elapsed time

### Requirement: Sidebar ownership lookup tolerates new-Thread persistence ordering
An ownership-list result of Codex means that no external Mapping Store record was observable for that Host Thread ID at that request. Because a new row can become visible before external persistence is observable, Renderer SHALL treat an initial Codex result as provisional and SHALL revalidate it with a finite bounded backoff. Renderer SHALL accept an external icon only from an exact local Composer association or a later validated Host external-ownership result; retry timing alone MUST NOT infer external ownership. After the retry budget is exhausted with only Codex results, the row SHALL remain undecorated.

#### Scenario: Mapping appears after the first ownership lookup
- **WHEN** the first ownership-list result for a new row is Codex and a bounded retry later reports a known external Harness
- **THEN** Renderer SHALL replace the provisional Codex cache entry with that external Agent
- **AND** it SHALL render the matching icon and stop retrying that Thread

#### Scenario: Persisted Codex ownership remains absent
- **WHEN** every ownership result through the bounded retry budget is Codex and no exact local external Composer matches the row
- **THEN** Renderer SHALL leave the row undecorated and stop automatic retries

#### Scenario: Local state resolves during ownership retry
- **WHEN** an exact local Composer association identifies the row while a provisional Codex retry is pending
- **THEN** Renderer SHALL use the local Agent, cancel the pending retry, and retain any validated Host Thread association in the process-local cache

### Requirement: Sidebar ownership decoration survives virtualized row lifecycle
Renderer SHALL cache successful process-local ownership by validated Host Thread ID, coalesce DOM scans, and revalidate row connectivity plus its exact DOM/Fiber-derived Host Thread ID before applying asynchronous results. It SHALL remove or replace owned decoration when React replaces title content, recycles a row for another Thread, or the extension is disposed. Ownership retries SHALL be finite and their timers and provisional state SHALL be cleared when ownership resolves, an explicit refresh invalidates the provisional result, or Renderer is disposed.

#### Scenario: Row is reused before ownership resolves
- **WHEN** a mounted row changes from one Thread ID to another before the earlier ownership request or retry completes
- **THEN** Renderer SHALL NOT apply the earlier Thread's Agent icon to the reused row

#### Scenario: React replaces the row title DOM
- **WHEN** an externally owned row remains mounted but its title subtree is replaced
- **THEN** Renderer SHALL restore exactly one matching Agent icon from cached ownership

#### Scenario: Renderer Extension is disposed
- **WHEN** the Renderer Binding Probe is disposed
- **THEN** it SHALL disconnect sidebar observation, cancel ownership retry timers, remove owned Agent icons, and ignore pending ownership results

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

### Requirement: 受支持 Desktop 必须为外部 Thread 使用原生上下文 Usage 界面

对于受支持的 Codex Desktop build，Host MUST 通过已评审的原生 `thread/tokenUsage/updated` Notification 投影完整外部 Thread Usage，使现有上下文窗口界面反映所选 Harness 的真实 Native Session。Renderer Extension MUST NOT 增加第二个上下文表盘、轮询 Pi 专用 Request、检查 Model carrier 获取上下文大小，或暴露通用 Host Request bridge。

#### Scenario: Pi 上下文 Usage 可用

- **WHEN** 可见 Pi Thread 收到协议有效的 Usage Notification，其中包含实际上下文已用 Token 和最大窗口
- **THEN** 现有 Desktop 上下文窗口界面 MUST 显示相应的有界百分比和 Token 数值关系
- **AND** 该 Thread MUST 保持选中 Pi 且锁定

#### Scenario: Usage 缺失或不完整

- **WHEN** 所属 Harness 尚未报告完整且可投影的上下文快照
- **THEN** 外部 Thread MUST 保持可用，且不得显示虚构百分比
- **AND** Renderer MUST NOT 复用其他 Composer、Thread、Session、Model 或过期 Request generation 的 Usage

#### Scenario: 恢复后的外部 Thread 变为可见

- **WHEN** 受支持 conversation target 已恢复，且 Host 从其 Native Session 读取当前 Usage
- **THEN** 原生上下文窗口界面 MUST 在归属解析之后为准确的 Host Thread 刷新
- **AND** Renderer MUST NOT 解析 Prompt、Transcript、Native Ref 或 Model carrier

#### Scenario: Desktop 协议结构改变

- **WHEN** 当前生成的 app-server Schema 或受控视觉 Gate 不再接受已评审的 Usage Notification 结构
- **THEN** 外部 Usage 投影 MUST fail closed 并保持隐藏
- **AND** 系统 MUST NOT 安装启发式 DOM 表盘作为 fallback

### Requirement: Renderer Model control is capability-driven for external Harnesses
For a supported Desktop build, Renderer SHALL use the fixed Harness inspection and Thread Model-selection methods for the currently selected external Harness when its inspection/session capability allows Model selection. It SHALL keep each Harness's Catalog and Model Ref opaque and MUST NOT branch on Claude or Pi native Model structure. Renderer SHALL persist each external Harness's most recent successful Model and Thinking selection as a new-Thread preference, validate it against each fresh Catalog, and SHALL NOT apply that preference while restoring an Existing Thread.

#### Scenario: User selects Claude Code
- **WHEN** a new Claude Composer requests inspection and Claude returns a ready selectable Catalog
- **THEN** the existing codexhost Model control displays normalized Claude labels, selects the most recent valid Claude preference or the default Ref, and may display the bounded resolved Model label
- **AND** it does not show a Claude Thinking selector while `selectThinkingOption=false`

#### Scenario: User selects Pi after Claude
- **WHEN** the same draft changes from Claude Code to Pi
- **THEN** Renderer invalidates the Claude request generation and loads or restores only that Composer's Pi Catalog and selection
- **AND** a late Claude inspection cannot overwrite Pi state

#### Scenario: User returns to Codex
- **WHEN** an external Composer changes to Codex before submission
- **THEN** Renderer hides the codexhost Model control and restores the captured opaque official Model state
- **AND** it does not write any external selection through the official persistent Model setter

#### Scenario: External inspection is unavailable
- **WHEN** the fixed request manager is absent, inspection fails, or the returned Catalog is malformed
- **THEN** the affected external Model control fails closed and submission requiring unresolved configuration is blocked
- **AND** no generic request bridge or guessed Model list is used

### Requirement: Claude Model state follows the logical Composer lifecycle
Renderer SHALL scope selected Claude Model Ref, resolved Model display, Catalog, and asynchronous request generation to the same logical Composer identity used for Agent routing. Draft creation SHALL use the request-local carrier, while an existing Claude Thread SHALL change Model only through its validated Host Thread identity and confirmed Session state.

#### Scenario: Submitted Claude creation retains Model
- **WHEN** a submitted and locked Claude new-Thread Composer transitions from the default target to its created conversation target
- **THEN** the replacement retains the selected Claude Ref and locked Agent state for that exact create

#### Scenario: New task uses the Claude preference
- **WHEN** a Claude conversation transitions to a new default Composer
- **THEN** the new Composer may use the most recently submitted Agent and initializes from the most recent valid Claude Model and Thinking preference
- **AND** it does not inherit uncommitted Model state from the prior Thread Composer

#### Scenario: Existing Claude Thread selects an alias
- **WHEN** a validated current-process Claude Thread selects another Catalog Ref while Idle
- **THEN** Renderer sends the fixed Thread Model-selection request and applies only Host-confirmed `effectiveModel` and `resolvedModelLabel`

#### Scenario: Claude selection fails
- **WHEN** Host rejects Model selection or the Session faults before confirmed state
- **THEN** Renderer keeps the prior confirmed selection when still valid, shows an explicit unavailable state, and does not rewrite the carrier to the requested Ref

#### Scenario: Claude result becomes stale
- **WHEN** an inspection or selection resolves after Agent, Composer, target, request generation, or extension lifetime changed
- **THEN** Renderer ignores the result and preserves the newer state

#### Scenario: Existing external Thread opens
- **WHEN** Host ownership inspection restores a Pi or Claude Code conversation
- **THEN** Renderer uses only that Thread's Host-confirmed Model and Thinking state
- **AND** opening or revisiting the Thread neither reads nor overwrites the new-Thread Model and Thinking preference

### Requirement: Renderer projects provider-native Permission Mode controls

On the supported Desktop build, Renderer SHALL identify the unique official permission trigger by its semantic navigation attribute and bounded Composer ownership. Codex SHALL retain that official trigger unchanged. Pi SHALL hide it without a replacement. Claude Code SHALL hide it and mount a codexhost picker in the same parent and position using only its Adapter catalog.

#### Scenario: User selects Codex

- **WHEN** the current Composer belongs to Codex
- **THEN** the official Codex permission control SHALL remain visible and codexhost SHALL perform no Permission Mode request

#### Scenario: User selects Pi

- **WHEN** the current Composer belongs to Pi
- **THEN** the official Codex permission control SHALL be hidden and no replacement mode picker SHALL be shown

#### Scenario: User selects Claude Code

- **WHEN** Claude inspection reports selectable Permission Modes
- **THEN** the replacement picker SHALL display exactly the Adapter catalog with provider-native labels
- **AND** it SHALL visually distinguish the dangerous bypass option without changing its semantics

#### Scenario: Current Claude catalog does not support Auto

- **WHEN** Claude inspection omits `auto` because no native Model explicitly supports it
- **THEN** Renderer SHALL not display or restore Auto and SHALL fall back from a stale Auto preference to the catalog default

### Requirement: Claude mode preference supplies provider defaults

Renderer SHALL persist the last user-selected Claude Permission Mode as one provider preference. A new Claude draft, including after Desktop restart, SHALL use that preference when it remains in the current catalog. A persisted Existing Thread carrier SHALL take precedence over the provider preference for that Thread.

#### Scenario: User changes a Claude mode and opens a new Thread

- **WHEN** the user selects a catalog mode in any Claude picker and later opens a new Claude draft
- **THEN** the new draft SHALL preselect that last user choice and include it in its request-local create carrier

#### Scenario: Existing Thread is revisited after restart

- **WHEN** its persisted carrier contains a valid Claude Model Ref and Permission Mode ID
- **THEN** Renderer SHALL restore that Thread's own mode instead of replacing it with the provider preference

#### Scenario: Stored preference is no longer in the catalog

- **WHEN** the persisted provider preference is absent from the current Claude catalog
- **THEN** Renderer SHALL use the catalog default without inventing or translating a mode

### Requirement: Renderer applies Claude mode changes through the owning Session

A Claude draft selection SHALL update the provider preference and its bounded request-local carrier. An Existing Thread selection SHALL call only `codexhost/thread/permission-mode/select`, then apply the current catalog mode returned by Host. Native rejection SHALL leave the Thread on its prior current mode and show an ordinary selection error; it SHALL NOT fault the Renderer or route the Thread to Codex.

#### Scenario: Existing Claude mode changes successfully

- **WHEN** Host returns a selectable current mode after the owning SDK setter completes
- **THEN** Renderer SHALL update the picker and carrier to that returned mode

#### Scenario: Native mode selection fails

- **WHEN** Host reports an SDK rejection such as model-ineligible `auto`
- **THEN** the Existing Thread SHALL retain its prior mode and remain usable
- **AND** the provider preference SHALL remain the user's last selected default for future Claude drafts

### Requirement: Renderer prerequisites SHALL gate only external capability availability
Renderer Model target uniqueness、Adapter readiness、Draft Prewarm clearing和Title Policy ownership SHALL保持外部Agent切换与提交的必要条件。失败 MUST使对应外部能力不可用，但 SHALL NOT终止受管Desktop或成为Launcher兼容提示。

#### Scenario: Agent Model target在恢复期间不可用
- **WHEN** Adapter无法识别唯一受支持Composer Model target
- **THEN** Pi和Claude Code切换或提交 SHALL保持不可用
- **AND** Controller SHALL继续后台恢复且官方Codex保持可用

#### Scenario: 外部选择清理Draft Prewarm失败
- **WHEN** 外部Agent切换无法清除owned Draft prewarm
- **THEN** 切换 SHALL失败且Adapter SHALL保持外部提交不可用
- **AND** 受管Desktop SHALL继续运行并允许后续恢复

### Requirement: 未评审标题服务标识 SHALL NOT 单独阻断安全安装
主进程标题策略 SHALL 把服务必要结构与已评审压缩身份分开判断。只有在标题服务路径、prototype `generateTitle`、已评审函数结构和Renderer ownership安装均成立时，未知压缩类名 MAY被分类为有界warning并继续安装。必要结构失败 SHALL使外部Agent能力保持不可用并进入Controller后台恢复，但 MUST NOT终止受管Desktop或产生Launcher兼容错误。

#### Scenario: 只有压缩类名变化
- **WHEN** `threadMetadataGeneration`服务来自已评审AppHost路径，prototype `generateTitle`及其函数结构匹配，Renderer ownership可以唯一建立，但`constructor.name`不在已评审集合
- **THEN** 标题策略 SHALL 完成ownership包装、Renderer reload和readiness
- **AND** locked Codex仍 SHALL调用原始官方标题服务
- **AND** Pi、Claude Code、未知外部Agent和歧义ownership仍 SHALL返回本地fallback
- **AND** 安装状态 SHALL携带`unreviewed-title-service-identity` warning

#### Scenario: 必要标题结构失败
- **WHEN** 服务路径、service prototype、`generateTitle`函数、已评审函数结构或Renderer ownership任一缺失、歧义或不匹配
- **THEN** 标题策略 SHALL拒绝本次外部能力安装并保持Pi与Claude Code不可用
- **AND** Controller SHALL保留受管Desktop并后台重试，不得向Launcher发送阻断兼容结果

#### Scenario: 已评审标识完整匹配
- **WHEN** 必要标题结构通过且服务压缩类名位于已评审集合
- **THEN** 标题策略 SHALL按现有行为安装且不产生未评审身份warning
