## MODIFIED Requirements

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

### Requirement: Claude Native history maps deterministically
`readSnapshot()` SHALL read only the identified Native Session through the official Claude SDK history API and SHALL deterministically map each human User message and its following supported Assistant text and explicit visible thinking into one Host Turn. The caller-assigned User UUID SHALL remain the Native Turn identity. Claude Tool-result User messages, synthetic or metadata User records, local-command output or caveat records, native Model-selection command envelopes, and background task-notification records SHALL NOT become human Host Turns. Other genuine human slash-command prompts SHALL remain eligible for projection. codexhost SHALL NOT persist a second Transcript.

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

#### Scenario: Native history contains background task-notification records
- **WHEN** Claude history contains a User record whose origin is `task-notification` or whose text is a complete `<task-notification>` wrapper
- **THEN** that native control record SHALL NOT create a Host Turn or appear as User input
- **AND** following Assistant continuations SHALL remain on the preceding human Turn
- **AND** ordinary human text that only mentions these tags SHALL remain eligible for projection

#### Scenario: Native history contains another human slash command
- **WHEN** a human User record contains a supported slash-command envelope other than the native Model-selection control record
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

## ADDED Requirements

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
