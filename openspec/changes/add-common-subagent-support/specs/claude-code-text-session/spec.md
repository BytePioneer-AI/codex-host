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

## ADDED Requirements

### Requirement: Claude Code maps Agent delegation to the common Subagent contract
Claude Code SHALL advertise Subagent observation and SHALL map Root `Agent` or `Task` Tool delegation plus correlated structured task notifications into Host Subagent Delegation Items. It SHALL expose only bounded common metadata and SHALL keep full internal prompts, transcript paths, SDK task records, and nested Tool activity private.

#### Scenario: Root starts an Agent Tool
- **WHEN** a Root Assistant message contains a valid `Agent` or `Task` Tool Use
- **THEN** Claude Adapter SHALL start one correlated Host Subagent Delegation Item instead of an ordinary Generic Tool Item
- **AND** it SHALL derive common description, role, and background fields from validated bounded Tool arguments

#### Scenario: Structured task progress is available
- **WHEN** Claude emits correlated `task_started`, `task_progress`, `task_updated`, or `task_notification` messages while the delegation Item is active
- **THEN** Claude Adapter SHALL update only that delegation's normalized state
- **AND** it SHALL tolerate absent optional task messages without failing the Root Turn

#### Scenario: Agent Tool result returns
- **WHEN** the correlated Root Agent or Task Tool Result returns with a stable `agentId`
- **THEN** Claude Adapter SHALL preserve that native identity for Child Host Thread registration and complete the spawn operation according to the Tool Result outcome
- **AND** a successful background launch SHALL keep the native Subagent running while allowing the Root Turn to finish without waiting for later background completion
- **AND** Claude Adapter SHALL distinguish an asynchronous launch acknowledgement from the delegated Agent's terminal result

#### Scenario: Root sends more work to an existing Agent
- **WHEN** Claude invokes `SendMessage` with an existing native Agent recipient
- **THEN** Claude Adapter SHALL emit a send delegation targeting that same native Subagent
- **AND** successful message delivery SHALL leave the Agent running rather than report the Agent completed

#### Scenario: Background task notification resumes Claude
- **WHEN** Claude consumes a task notification after the requested Host Turn has completed and generates a follow-up Root answer
- **THEN** Claude Transport SHALL parse its stable `task-id`, preserve the full continuation until its native Result, and report that Subagent's terminal state
- **AND** Claude Adapter SHALL emit the correlated Session-scoped Subagent completion and one autonomous Host Turn with stable native identity

### Requirement: Claude exposes read-only Subagent history
Claude Adapter SHALL implement the common Subagent transcript capability using the official `getSubagentMessages()` API and SHALL map supported User, Assistant, Reasoning, Tool Use, and Tool Result content into deterministic Child Host Thread history without persisting another transcript.

#### Scenario: Child Thread is opened
- **WHEN** Host Runtime requests history for a stable Claude `agentId`
- **THEN** Claude Adapter SHALL read that Subagent's official transcript under the Parent Native Session
- **AND** Bash executions SHALL be represented as Command Items while other supported native tools SHALL be represented as Tool Items with their available results
- **AND** nested Subagent Assistant and Tool evidence SHALL invalidate the correlated Child transcript after stable `task_id` association while remaining excluded from the Root transcript
- **AND** when the official Subagent history omits the initial User prompt, the Adapter SHALL restore that prompt from the correlated Parent Agent or Task Tool Use and project the returned Assistant and Tool evidence under the same stable initial Child Turn identity used when that prompt is present
- **AND** repeated reads SHALL return deterministic ordered Child Turn identities and visible content

#### Scenario: Subagent history is unavailable
- **WHEN** the native Subagent transcript is missing or malformed
- **THEN** Claude Adapter SHALL return a normalized read failure
- **AND** it SHALL NOT substitute Root Session history or manufacture Child content
