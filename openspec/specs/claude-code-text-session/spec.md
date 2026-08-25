# claude-code-text-session Specification

## Purpose
Define the production Claude Code Adapter contract for lazy create and resume, deterministic Native history Snapshot reads, text Turns, cancellation, exact same-directory Fork, faults, and bounded close without exposing Claude SDK details outside the Adapter package.
## Requirements
### Requirement: Claude Code implements the existing HarnessAdapter contract
The system SHALL provide a concrete Claude Code Adapter that exposes the existing UI-independent create, resume, history Snapshot, text Turn, cancel, fault, and close semantics. Claude SDK objects, message types, settings, process handles, and native protocol fields MUST remain inside the Adapter package.

#### Scenario: Host opens a Claude create Session
- **WHEN** a caller opens a create-mode Session with a valid cwd
- **THEN** the Adapter SHALL return a HarnessSession with Harness ID `claude-code`
- **AND** it SHALL NOT start Claude Code or create an empty Native Session

#### Scenario: Ordinary tests run
- **WHEN** repository formatting, lint, typecheck, build, or normal tests run
- **THEN** Fake Transport tests SHALL exercise the Adapter contract
- **AND** no test SHALL launch Claude Code, read user authentication, create Native Sessions, or consume model quota

### Requirement: Claude inspection separates installation from configuration support
The Claude Code Adapter SHALL inspect its configured user executable and, when available, start one no-Prompt official Agent SDK Query using the same cwd, environment, and setting sources as production to read the initialization Model list, stable actual-Model state, and structural Permission Mode setter support. It SHALL normalize only validated Model and Permission Mode control data, close all owned resources before resolving, and SHALL NOT create a persistent Native Session or call a model endpoint. Lack of proven Model operations MUST NOT by itself report an installed Harness as unavailable.

#### Scenario: Claude executable is resolvable
- **WHEN** Claude inspection resolves the configured executable
- **THEN** the Adapter performs the no-Prompt capability inspection and returns either a ready selectable Catalog or ready empty Catalog according to the structured runtime result
- **AND** it does not create a model Turn or persistent Native Session

#### Scenario: Claude executable exposes a valid Model catalog
- **WHEN** Claude inspection receives valid selectable Model information and current actual-Model readback
- **THEN** the Adapter returns ready inspection with a non-empty deterministic Catalog, a default Ref, optional resolved labels, and `configuration.selectModel=true`
- **AND** it keeps `configuration.selectThinkingOption=false`

#### Scenario: Host startup prefetches the Claude Catalog
- **WHEN** production Host composition registers the Claude Adapter
- **THEN** it starts one background no-Prompt inspection without waiting before starting official Codex routing
- **AND** a later same-cwd inspection reuses the in-flight or successful memory cache
- **AND** missing, unavailable, or failed Claude inspection does not block Codex/Pi startup

#### Scenario: Claude executable lacks required Model operations
- **WHEN** Claude Code initializes but its compatible SDK surface cannot provide a valid selectable Catalog, Model setter capability, or stable actual-Model readback
- **THEN** the Adapter returns ready inspection with an empty Model catalog and `configuration.selectModel=false`
- **AND** it independently reports Permission Mode capability only when the official Query exposes its setter
- **AND** it does not infer support from a version string, settings file, Model name, or description

#### Scenario: Claude executable is missing
- **WHEN** Claude inspection cannot resolve the configured executable
- **THEN** the Adapter returns a normalized `notInstalled` inspection
- **AND** it does not defer that known failure to a created Host Thread

#### Scenario: Claude inspection closes without a Prompt
- **WHEN** successful or failed Model inspection settles
- **THEN** every owned Query and Claude process exits before the result resolves
- **AND** official Session lookup reports no created Native Session

### Requirement: Claude startup is lazy and Native identity is confirmed
The first accepted text Turn SHALL resolve the user-installed Claude Code executable, initialize one long-lived Agent SDK Query with an optional Adapter-owned selectable Model Ref and selected Permission Mode, publish one Native Session Ref plus current configuration state before that Turn lifecycle, and later reuse the same Query and Native Session. Opening a create or resume Session without a Turn SHALL remain process-free even when create carries Model or Permission Mode configuration.

#### Scenario: Unused Claude Session closes
- **WHEN** a Claude HarnessSession closes without a Turn
- **THEN** no Claude process or Native Session is created

#### Scenario: Claude is not installed
- **WHEN** the first Turn cannot resolve an executable user installation
- **THEN** the command fails before acceptance with `notInstalled`
- **AND** no Turn or Item lifecycle is emitted

#### Scenario: First Turn uses the selected concrete Model
- **WHEN** create input carries a valid Claude Model Ref and the first Turn starts
- **THEN** the Adapter decodes the exact SDK selectable value, initializes the long-lived Query with it, reads stable actual Model state, and emits complete Session state before `turn.started`

#### Scenario: First Turn uses Claude default
- **WHEN** create input uses the Claude default Ref or omits an explicit Ref
- **THEN** the Adapter omits a fixed Model override and publishes the actual Model resolved by Claude Code's current default policy

#### Scenario: Two sequential Turns run
- **WHEN** one Session accepts and completes two text Turns
- **THEN** one SDK Query and one Native Session serve both Turns
- **AND** each caller-assigned User UUID is submitted once

### Requirement: Claude Native history maps deterministically
`readSnapshot()` SHALL read only the identified Native Session through the official Claude SDK history API and SHALL deterministically map each human User message and its following supported Assistant text and explicit visible thinking into one Host Turn. The caller-assigned User UUID SHALL remain the Native Turn identity. Claude Tool-result User messages, synthetic or metadata User records, local-command output or caveat records, native Model-selection and Compact command envelopes, and background task-notification records SHALL NOT become human Host Turns. Other genuine human slash-command prompts SHALL remain eligible for projection. codexhost SHALL NOT persist a second Transcript.

#### Scenario: Completed Claude history is read repeatedly
- **WHEN** a Claude Session containing completed text Turns and visible Assistant thinking is read more than once
- **THEN** every read SHALL return the same ordered Native Turn identities, inputs, Agent Message and Reasoning identities, supported text, and outcomes
- **AND** the read SHALL NOT start a Claude Query or emit live Session outputs

#### Scenario: Native Tool messages occur within a Turn
- **WHEN** Assistant Tool use and User Tool-result messages occur between a human User message and the terminal Assistant message
- **THEN** those messages SHALL remain within the same historical Turn
- **AND** only currently supported Assistant text and explicit visible thinking SHALL be projected as historical Items

#### Scenario: Native history contains model-selection records
- **WHEN** Claude history contains a `/model` command envelope, `<local-command-stdout>` result, or `<local-command-caveat>` adjacent to human conversation
- **THEN** those native control records SHALL NOT create Host Turns
- **AND** the surrounding human Turns SHALL retain their Native Turn identities and order

#### Scenario: Native history contains compact-command records
- **WHEN** Claude history contains a `/compact` command envelope adjacent to human conversation
- **THEN** that native control record SHALL NOT create a Host Turn
- **AND** the surrounding human Turns SHALL retain their Native Turn identities and order

#### Scenario: Native history contains init or recap command records
- **WHEN** Claude history contains a `/init` command envelope followed by Assistant text, or a `/recap` command envelope followed by `<local-command-stdout>`
- **THEN** those records SHALL create Host Turns
- **AND** the User input SHALL be `/init` or `/recap`
- **AND** recap stdout SHALL project as the Agent Message rather than a human Turn

#### Scenario: Native history contains background task-notification records
- **WHEN** Claude history contains a User record whose origin is `task-notification` or whose text is a complete `<task-notification>` wrapper
- **THEN** that native control record SHALL NOT create a Host Turn or appear as User input
- **AND** following Assistant continuations SHALL remain on the preceding human Turn
- **AND** ordinary human text that only mentions these tags SHALL remain eligible for projection

#### Scenario: Native history contains another human slash command
- **WHEN** a human User record contains a supported slash-command envelope other than the native Model-selection or Compact control record
- **THEN** the command prompt SHALL remain eligible to create a Host Turn
- **AND** transcript tags SHALL NOT cause unrelated human text to be discarded

#### Scenario: Native history contains redacted or unsupported blocks

- **WHEN** an Assistant message contains redacted thinking, signatures, encrypted data, Tool blocks, or another unsupported non-text block
- **THEN** the history mapper SHALL omit that content from Reasoning
- **AND** it SHALL NOT expose the native block through another Host Item

#### Scenario: Native history omits complete Result evidence
- **WHEN** official history contains Assistant messages but not the complete Result fields required by Claude live terminal classification
- **THEN** the historical Turn outcome SHALL remain `unknown`
- **AND** the Adapter SHALL NOT infer success from Assistant `stop_reason` or Reasoning alone

#### Scenario: Native history identity is inconsistent
- **WHEN** history contains a mismatched Session identity, duplicate message identity, or malformed conversation message
- **THEN** `readSnapshot()` SHALL fail with a normalized protocol error
- **AND** no partial Snapshot SHALL be returned

### Requirement: Claude resume preserves Native Session identity

`open(resume)` SHALL bind the exact persisted Claude Native Session Ref without starting a Query. It SHALL expose that Ref in initial Session state, read current Native history before Host restoration completes, and start a Query with the official SDK `resume` option only when a later Turn is submitted. Claude Code SHALL report exact Fork capability for the same working directory and SHALL reject cross-directory Fork explicitly.

#### Scenario: Host restores a persisted Claude Thread
- **WHEN** Host opens a valid Claude Native Session Ref in resume mode and reads its Snapshot
- **THEN** the Adapter SHALL return the current Native history without creating a replacement Session
- **AND** the next accepted Turn SHALL continue that same Native Session

#### Scenario: Resumed Native Session is missing
- **WHEN** official history reading returns no messages for a resumed Native Session Ref
- **THEN** the Adapter SHALL return `sessionNotFound`
- **AND** it SHALL NOT start a Query or create a replacement Session

#### Scenario: Caller requests Claude Fork
- **WHEN** a caller invokes `open(fork)` with an exact Checkpoint from the same working directory
- **THEN** the Adapter SHALL create a distinct Native Session whose Snapshot ends at that Checkpoint
- **AND** source history SHALL remain unchanged

#### Scenario: Caller requests cross-directory Claude Fork
- **WHEN** a caller invokes `open(fork)` with a different working directory
- **THEN** the Adapter SHALL return `unsupported`
- **AND** source history SHALL remain unchanged

### Requirement: Claude text streaming has one complete ordered lifecycle
Every accepted Claude text Turn SHALL emit one Turn start, retain the established Root Agent Message lifecycle, emit zero or more Root Reasoning Item lifecycles only for explicit streamed Claude thinking, emit one terminal for every started Item, and emit one Turn terminal. Partial and complete Root Assistant text SHALL be reconciled by native execution scope and native Assistant `message.id`; complete content from a later Root response in the same Tool loop SHALL NOT be treated as a cumulative snapshot of the Host Turn. Claude messages carrying a non-empty `parent_tool_use_id` SHALL remain nested execution and SHALL NOT append, compare with, create, or close Root Assistant, Reasoning, or ordinary Tool Items. Live Reasoning SHALL use only Root `thinking_delta` text and SHALL ignore complete Assistant `thinking` blocks. Unknown native message types and all unsupported non-text content MUST NOT cross the HarnessAdapter seam.

#### Scenario: Partial text and full Assistant agree
- **WHEN** SDK partial events stream a Root text prefix and the complete Root Assistant message with the same native `message.id` contains the prefix plus a suffix
- **THEN** the Adapter SHALL append each character exactly once
- **AND** it SHALL append only the missing suffix from the complete message

#### Scenario: Streaming is unavailable
- **WHEN** no partial text event is emitted but a complete Root Assistant text message arrives
- **THEN** the Adapter SHALL publish that complete text once before the Item terminal

#### Scenario: Tool loop has text before and after a permission decision
- **WHEN** one Host Turn contains a Root Assistant text response, a Tool permission callback and result, and a later Root Assistant text response before the native Turn Result
- **THEN** the Adapter SHALL reconcile each complete response only with partial text emitted for that response's native `message.id`
- **AND** it SHALL append both responses in order exactly once without reporting a text conflict merely because the later response omits earlier Turn text

#### Scenario: Subagent messages interleave with Root streaming
- **WHEN** Root text deltas are followed by nested Assistant, Reasoning, Tool Use, or Tool Result messages carrying a non-empty `parent_tool_use_id`, followed by more Root text
- **THEN** the nested messages SHALL NOT append to or close any Root Agent Message or Reasoning Item
- **AND** the later Root text SHALL continue in its own native Root message lifecycle without a text conflict

#### Scenario: Native text conflicts
- **WHEN** a complete Root Assistant text cannot be reconciled with partial text already emitted for the same Root execution scope and native `message.id`
- **THEN** every started Item and the Turn SHALL fail exactly once
- **AND** the Adapter SHALL NOT replay or replace the visible text silently

#### Scenario: Streamed thinking has a complete Assistant counterpart
- **WHEN** Root SDK stream events emit non-empty `thinking_delta` text for one Assistant message and the complete Assistant wrapper with the same native `message.id` contains thinking blocks
- **THEN** the Adapter SHALL append only the `thinking_delta` text through one Reasoning Item for that message
- **AND** it SHALL ignore the complete `thinking` blocks without appending their suffix

#### Scenario: Thinking streaming is unavailable
- **WHEN** no Root partial thinking event is emitted but a complete Assistant message contains non-empty visible thinking text
- **THEN** the Adapter SHALL emit no Reasoning Item from the complete `thinking` blocks

#### Scenario: One Turn contains multiple Assistant messages
- **WHEN** a Claude Tool loop or retry produces Root `thinking_delta` text in more than one native Assistant message
- **THEN** the Adapter SHALL keep those messages as ordered distinct Reasoning Item lifecycles
- **AND** complete Assistant `thinking` blocks SHALL NOT compare against, extend, or replay either message's text

#### Scenario: Complete thinking differs from streamed thinking
- **WHEN** complete visible thinking for one Root Assistant message differs from the thinking already emitted for that message
- **THEN** the Adapter SHALL ignore the complete thinking without replacing or duplicating visible Reasoning
- **AND** the complete thinking difference SHALL NOT affect the Turn outcome

#### Scenario: Claude emits unsupported thinking forms
- **WHEN** Claude emits redacted thinking, signatures, encrypted content, empty thinking boundaries, or an unknown non-text block
- **THEN** the Adapter SHALL emit no Reasoning text for that content
- **AND** the existing Turn lifecycle and unknown-message tolerance SHALL remain unchanged

### Requirement: Claude Result classification uses complete native evidence
A Claude Turn SHALL succeed only when the complete Result and Assistant evidence prove completion. The Adapter MUST inspect `subtype`, `is_error`, `terminal_reason`, Assistant error, and local cancel state rather than trusting one discriminant.

#### Scenario: Nominal success contains native error evidence
- **WHEN** a Result has `subtype=success` but `is_error=true`, a non-completed terminal reason, or an Assistant error
- **THEN** the Adapter SHALL complete the Turn as failed
- **AND** it SHALL map authentication evidence to `authenticationRequired` where applicable

#### Scenario: Successful Result completes
- **WHEN** the Result is non-error, completed, and has no Assistant error
- **THEN** the Agent Message and Turn SHALL complete succeeded exactly once

### Requirement: Claude cancellation waits for authoritative Result
A successful `turn.cancel` SHALL call SDK Interrupt but SHALL not terminate the Host Turn until native Result evidence arrives. Repeated cancel requests SHALL be idempotent, and the same Session SHALL remain reusable after proven cancellation.

#### Scenario: Streaming Turn is cancelled
- **WHEN** Interrupt is accepted for the active Turn and native Result ends with `aborted_streaming` or `aborted_tools`
- **THEN** every started Item SHALL complete cancelled before one `turn.completed(cancelled)`

#### Scenario: Abort cannot be proven
- **WHEN** Interrupt rejects, times out, the process exits, or Result does not carry a proven aborted terminal
- **THEN** the Turn SHALL fail rather than report cancelled

#### Scenario: Turn follows cancellation
- **WHEN** a cancelled Turn reaches its terminal event and the Query remains healthy
- **THEN** the same Session SHALL accept and complete a later text Turn

### Requirement: Claude close and faults are bounded and private
Session and Adapter close SHALL be idempotent, reject new commands after closing begins, terminate owned direct Claude processes within configured bounds, and preserve Native Session history. Unrecoverable Query or process faults SHALL finalize active lifecycles before `session.faulted` and stream end.

#### Scenario: Adapter closes multiple Sessions
- **WHEN** Adapter close is called more than once
- **THEN** every opened Session SHALL close once
- **AND** all calls SHALL converge on the same bounded result

#### Scenario: Query faults during an accepted Turn
- **WHEN** the SDK iterator or owned Claude process fails before an authoritative Result
- **THEN** the Item and Turn SHALL fail exactly once before `session.faulted`
- **AND** raw SDK errors, Prompt text, credentials, and native frames SHALL not enter Host outputs

### Requirement: Claude package root exposes only production Adapter ownership
The Claude Code Adapter package root SHALL directly export only the concrete Adapter, its production options, and package metadata. It SHALL NOT directly re-export Claude SDK transport interfaces, native message accumulators, executable helpers, or test dependency types.

#### Scenario: Production Host imports Claude Adapter
- **WHEN** Host composition imports the Claude package root
- **THEN** it SHALL consume only ClaudeCodeAdapter and package metadata
- **AND** no Claude SDK message or transport type SHALL enter Host production code

#### Scenario: Adapter tests inject a fake transport
- **WHEN** Claude Adapter tests need deterministic native behavior
- **THEN** they SHALL use package-internal test seams
- **AND** the production package root SHALL not expand for that test

### Requirement: Claude Code publishes stable current context Usage

The Claude Code Adapter MUST read current context Usage only from the active official SDK Query's stable structured context operation. It MUST map reliable current used Token and effective maximum Token values into one normalized `HostUsage` context pair after each validated complete Assistant message and after the Turn terminal, and MUST omit unavailable Session aggregate, cost, category, percentage, or Model fields rather than deriving them. It MUST NOT depend on the SDK experimental Session Usage operation or interpret per-Result Usage as a Native Session aggregate.

#### Scenario: Claude Assistant message exposes context during an active Turn

- **WHEN** an accepted Claude Turn receives a validated complete Assistant message and the active Query returns valid current context while Tool work or a later Assistant response remains pending
- **THEN** the Adapter MUST publish a `session.usage.changed` snapshot associated with the active Turn
- **AND** the Adapter MUST NOT wait for the native Result before first providing the current context pair

#### Scenario: Successful Claude Turn exposes current context

- **WHEN** an accepted Claude Turn reaches its authoritative terminal and the active Query returns valid current context used and maximum Token values
- **THEN** the Adapter MUST publish one `session.usage.changed` snapshot containing the corresponding `contextUsedTokens` and `contextWindowTokens`
- **AND** the snapshot MUST remain Session-level Telemetry associated with that observation boundary

#### Scenario: Claude context response is unavailable or malformed

- **WHEN** the stable context operation fails, returns no current context, or returns an invalid Token pair
- **THEN** the Adapter MUST omit that observation and preserve the latest still-applicable Usage or `null`
- **AND** the Turn outcome, Session health, and bounded close MUST remain unchanged

#### Scenario: Claude Session has not started a Query

- **WHEN** a create or resume Session has not accepted its first Turn
- **THEN** `initialUsage` MUST remain `null`
- **AND** the Adapter MUST NOT start Claude Code only to obtain Usage

#### Scenario: An older context read completes after a newer boundary

- **WHEN** a context read started for an earlier Turn completes after another Turn starts, Session close begins, or the Session faults
- **THEN** the Adapter MUST discard that stale result
- **AND** it MUST NOT replace Usage owned by the newer Session boundary

### Requirement: Claude exposes compact as a registered Harness command

The Claude Code Adapter MUST publish `claude.compact` in the Session command catalog with invocation `/compact` and argument mode `text`. Execution MUST use the Adapter's dedicated compact transport, MUST project native compaction start and terminal outcomes as the standard Context Compaction Item on a temporary Turn, and MUST NOT assign a persisted Native Turn identity. The Adapter MUST reject unknown command IDs, invalid arguments, and busy Sessions.

#### Scenario: Catalog lists claude.compact

- **WHEN** a Claude Session lists commands
- **THEN** the catalog contains `claude.compact`
- **AND** the command declares `/compact` and argument mode `text`

#### Scenario: Manual compact uses native compact rather than a Host text Turn

- **WHEN** `claude.compact` is executed with optional text `Keep implementation details`
- **THEN** the Adapter starts a temporary Turn
- **AND** the Transport receives compact with that custom instruction
- **AND** it does not submit a Host text Turn
- **AND** Codex projects `contextCompaction` started and succeeded
- **AND** the Turn completes without a Native Turn identity

#### Scenario: Unknown or invalid compact is rejected

- **WHEN** command execution references an ID other than `claude.compact`, a non-string `text` argument, or an unknown argument key
- **THEN** the Adapter rejects the request
- **AND** no compact operation is started

#### Scenario: Compact is rejected during an active Turn

- **WHEN** `claude.compact` is executed while a Claude Turn is running
- **THEN** the Adapter rejects the request as session busy
- **AND** the running Turn is left unchanged

### Requirement: Claude exposes init and recap as registered Harness commands

The Claude Code Adapter MUST publish `claude.init` (`/init`) and `claude.recap` (`/recap`) with argument mode `none`. Execution MUST use dedicated Transport operations rather than a Host text Turn. `/init` MUST run as an Agent Turn that can write `CLAUDE.md`. `/recap` MUST project native local-command output as an Agent Message. Native `/init` and `/recap` command envelopes SHALL remain eligible for history projection; recap local-command stdout SHALL become the recap Agent Message rather than a human Turn.

#### Scenario: Catalog lists init and recap

- **WHEN** a Claude Session lists commands
- **THEN** the catalog contains `claude.init` and `claude.recap`
- **AND** both commands declare argument mode `none`

#### Scenario: Init generates CLAUDE.md without a Host text Turn

- **WHEN** `claude.init` is executed
- **THEN** the Adapter starts a command Turn
- **AND** the Transport receives init rather than a Host text Turn
- **AND** Assistant text and Tool work use the existing Item projection
- **AND** the Turn completes without a Native Turn identity

#### Scenario: Recap projects a one-line session summary

- **WHEN** `claude.recap` is executed and Claude emits local command output
- **THEN** the Adapter projects that output as an Agent Message
- **AND** it does not submit `/recap` as a Host text Turn

#### Scenario: Init and recap reject arguments

- **WHEN** `claude.init` or `claude.recap` is executed with any argument object
- **THEN** the Adapter rejects the request as invalid
- **AND** no native command is started

### Requirement: Claude Catalog uses official runtime data without configuration parsing
Claude Adapter SHALL derive selectable identity from official SDK `ModelInfo.value`, optional initial resolved display from structured SDK fields, and current actual display from stable structured current-context Model readback. It MUST NOT read `settings.json`, maintain a static first-party manifest, parse human descriptions, or advertise Models absent from the runtime Catalog.

#### Scenario: User maps Claude aliases to a custom Model
- **WHEN** the user's Claude Code configuration maps family aliases to GLM, MiniMax, Bedrock, or another compatible Model and the SDK exposes those resolved choices
- **THEN** inspection shows the SDK-provided selectable values and resolved labels
- **AND** it does not append unrelated hardcoded Sonnet, Opus, or Haiku versions

#### Scenario: Runtime returns sensitive Model metadata
- **WHEN** initialization also contains account, Provider, pricing, endpoint, path, credential, or unknown fields
- **THEN** Claude Adapter discards those fields before constructing the public Catalog

### Requirement: Claude Model selection uses setter plus stable actual readback
A started Claude Session SHALL support `model.select` only while Idle. The Adapter SHALL decode only its own Ref, call the official SDK Model setter, read the stable current actual Model, publish the complete selectable and resolved state, and only then complete the command.

#### Scenario: Idle selection resolves to a custom Model
- **WHEN** an Idle Session selects a family alias that Claude Code maps to a custom Model
- **THEN** Session state retains the alias Ref and reports the custom actual Model as `resolvedModelLabel`

#### Scenario: Default selection is restored
- **WHEN** an Idle Session selects the Adapter default Ref
- **THEN** Claude Adapter clears the explicit SDK Model override and publishes the actual default Model returned by readback

#### Scenario: Setter rejects selection
- **WHEN** the SDK rejects an unavailable or policy-disallowed selectable value before any uncertain write
- **THEN** the Adapter returns an explicit native failure and preserves the prior confirmed state

#### Scenario: Setter succeeds but readback fails
- **WHEN** the setter may have changed the Model and stable actual-Model readback is unavailable or malformed
- **THEN** the Adapter faults the Session rather than execute a later Turn under unknown Model state

### Requirement: Claude Thinking selection remains unsupported
Claude Adapter SHALL keep `configuration.selectThinkingOption=false` and SHALL reject `thinking.select` even when ModelInfo reports supported effort levels. It MUST NOT report a requested effort as effective without a stable structured Session readback proving the actual value.

#### Scenario: Catalog Model reports effort levels
- **WHEN** official ModelInfo reports one or more shape-valid supported effort level IDs, including an ID codexhost has not seen before
- **THEN** the Adapter may preserve those runtime IDs without a Claude-specific semantic allowlist or fixed label mapping and keeps each Model's supported set distinct
- **AND** Renderer does not expose a Claude Thinking selector in this Change

#### Scenario: Caller attempts Claude Thinking selection
- **WHEN** a create input or Session command supplies a Claude Thinking option
- **THEN** Claude Adapter returns `unsupported` and performs no native configuration write

### Requirement: Claude exposes the reviewed native Permission Modes

Claude Adapter SHALL expose `plan`, `default`, `acceptEdits`, and `bypassPermissions` with provider-native semantics. It SHALL expose `auto` only when at least one inspected native Model explicitly reports `supportsAutoMode=true`, SHALL NOT infer Auto support from setter presence or a custom Provider, and SHALL NOT expose `dontAsk` in the current catalog. Query creation SHALL keep `settingSources: ["user"]`, pass the selected Session mode, and set `allowDangerouslySkipPermissions: true` only as the SDK prerequisite for an explicit later bypass selection.

#### Scenario: First Turn uses the selected Permission Mode

- **WHEN** create input carries a valid Claude mode
- **THEN** the lazy Query SHALL initialize with that exact mode and publish the native effective mode in complete Session state before `turn.started`

#### Scenario: Custom Model does not declare Auto support

- **WHEN** every inspected native Model omits or denies `supportsAutoMode`
- **THEN** the normalized catalog SHALL omit `auto` while retaining the other native modes and selection capability

#### Scenario: Bypass capability is enabled but not selected

- **WHEN** the Query is created in any non-bypass mode
- **THEN** the dangerous SDK prerequisite SHALL NOT itself select bypass, add a rule, change Sandbox, or suppress an ordinary Approval callback

#### Scenario: SDK reports a catalog mode change

- **WHEN** a supported native init or status message reports a different catalog mode
- **THEN** Claude Adapter SHALL update the current Session mode through the ordered state stream
- **AND** a native mode outside the exposed catalog SHALL not fault the Session

### Requirement: Claude Permission Mode selection follows native Session behavior

A valid `permissionMode.select` SHALL call the current Query's official setter and, on success, publish the resulting mode before completing. It MAY run while a Turn is active, as supported by the SDK, and SHALL serialize only concurrent mode selections. Native rejection SHALL remain a normal command failure rather than a Session fault.

#### Scenario: User changes the current Session mode

- **WHEN** the SDK accepts `permissionMode.select`
- **THEN** later work in the same Session SHALL use the resulting mode without restarting the Native Session

#### Scenario: Auto is unavailable for the current Model

- **WHEN** the SDK rejects `auto` because the current Model is ineligible
- **THEN** Claude Adapter SHALL return a native failure and retain the prior current mode

#### Scenario: Tool permission is still requested

- **WHEN** Claude invokes `canUseTool` under the selected mode
- **THEN** the existing ordinary Tool Approval path SHALL remain authoritative for that callback

### Requirement: Claude Code maps Agent delegation to the common Subagent contract
Claude Code SHALL advertise Subagent observation and SHALL map Root `Agent` or `Task` Tool delegation plus correlated structured task notifications into Host Subagent Delegation Items. It SHALL expose bounded common metadata and the bounded user-authored delegated prompt while keeping Claude internal launch metadata, transcript paths, SDK task records, and nested Tool activity private.

#### Scenario: Root starts an Agent Tool
- **WHEN** a Root Assistant message contains a valid `Agent` or `Task` Tool Use
- **THEN** Claude Adapter SHALL start one correlated Host Subagent Delegation Item instead of an ordinary Generic Tool Item
- **AND** it SHALL derive common description, role, background, and public prompt fields from validated bounded Tool arguments

#### Scenario: Structured task progress is available
- **WHEN** Claude emits correlated `task_started`, `task_progress`, `task_updated`, or `task_notification` messages while the delegation Item is active
- **THEN** Claude Adapter SHALL update only that delegation's normalized state
- **AND** it SHALL tolerate absent optional task messages without failing the Root Turn

#### Scenario: A background Subagent settles before Claude answers for it
- **WHEN** Claude reports a background Subagent as settled through a task notification or by dropping it from the live background task level
- **THEN** Claude Adapter SHALL publish that Subagent's terminal state immediately
- **AND** it SHALL keep that Subagent occupying the user task, because the Root answer it triggers runs in a later native Segment
- **AND** occupancy SHALL be settled only when the native Session stops opening Segments for this user task, since the number of Segments Claude spends on queued notifications is not observable
- **AND** Root text, reasoning, Tool Use, or a Segment start SHALL cancel any pending idle decision so a slow continuation cannot close the Turn early

#### Scenario: Agent Tool result returns
- **WHEN** the correlated Root Agent or Task Tool Result returns with a stable `agentId`
- **THEN** Claude Adapter SHALL preserve that native identity for Child Host Thread registration and complete the spawn operation according to the Tool Result outcome
- **AND** a successful background launch SHALL keep the native Subagent running
- **AND** Claude Adapter SHALL distinguish an asynchronous launch acknowledgement from the delegated Agent's terminal result
- **AND** that launch acknowledgement SHALL NOT emit `turn.completed` while the native Subagent remains running
- **AND** occupancy SHALL start at the `run_in_background` Tool Use, keyed by `callId` until `agentId` is bound
- **AND** a later Root `result` or Assistant `message.completed` SHALL NOT emit `turn.completed` while any occupied background spawn from this user task remains unsettled

#### Scenario: Root sends more work to an existing Agent
- **WHEN** Claude invokes `SendMessage` with an existing native Agent recipient
- **THEN** Claude Adapter SHALL emit a send delegation targeting that same native Subagent
- **AND** successful message delivery SHALL leave the Agent running rather than report the Agent completed

#### Scenario: Background task notification resumes Claude
- **WHEN** Claude consumes a task notification while the requested Host Turn is still held for running background Subagents and generates a follow-up Root answer
- **THEN** Claude Transport SHALL parse its stable `task-id`, preserve the full continuation until its native Result, and report that Subagent's terminal state
- **AND** Claude Adapter SHALL emit the correlated Session-scoped Subagent completion on the same Host Turn
- **AND** it SHALL NOT emit `turn.completed` until no Root Segment, background Subagent, or continuation is executing, including a Subagent settled during an earlier Segment of the same user task
- **AND** Assistant `message.completed` SHALL close the current Root Agent Message Item without emitting `turn.completed`

#### Scenario: Background task notification resumes Claude after the requested Turn completed
- **WHEN** Claude consumes a task notification after the requested Host Turn has completed and generates a follow-up Root answer
- **THEN** Claude Adapter SHALL emit the correlated Session-scoped Subagent completion and one autonomous Host Turn with stable native identity

### Requirement: Claude exposes read-only Subagent history
Claude Adapter SHALL implement the common Subagent transcript capability using the official `getSubagentMessages()` API and SHALL map supported User, Assistant, Reasoning, Tool Use, and Tool Result content into deterministic Child Host Thread history without persisting another transcript.

#### Scenario: Child Thread is opened
- **WHEN** Host Runtime requests history for a stable Claude `agentId`
- **THEN** Claude Adapter SHALL read that Subagent's official transcript under the Parent Native Session
- **AND** Bash executions SHALL be represented as Command Items while other supported native tools SHALL be represented as Tool Items with their available results
- **AND** nested Subagent Assistant and Tool evidence SHALL invalidate the correlated Child transcript after stable `task_id` association while remaining excluded from the Root transcript
- **AND** when the official Subagent history omits the initial User prompt, the Adapter SHALL restore that prompt from the correlated Parent Agent or Task Tool Use and project the returned Assistant and Tool evidence under the same stable initial Child Turn identity used when that prompt is present
- **AND** repeated reads SHALL return deterministic ordered Child Turn identities and visible content
- **AND** after terminal state is observed, Host Runtime SHALL perform bounded follow-up reads so a briefly delayed final Assistant message is published to an already-open Child Thread

#### Scenario: Subagent history is unavailable
- **WHEN** the native Subagent transcript is missing or malformed
- **THEN** Claude Adapter SHALL return a normalized read failure
- **AND** it SHALL NOT substitute Root Session history or manufacture Child content

