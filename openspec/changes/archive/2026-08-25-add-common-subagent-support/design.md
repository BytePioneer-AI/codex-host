## Context

The public Harness contract currently represents Assistant, Reasoning, Command, Tool, and File Change Items only. Claude Code forwards nested Agent messages on the same SDK iterator, marking them with `parent_tool_use_id`, while the current accumulator has one active Assistant-stream identity and one Tool map for the whole Turn. Nested Assistant wrappers can therefore close or conflict with Root output, and nested Tools are flattened into the Root transcript.

Codex app-server exposes a native `collabAgentToolCall` Item whose receiver identifiers are expected to resolve as Child Threads. Claude Code exposes stable `agentId` values plus `getSubagentMessages()`, so codexhost can provide browsable read-only Child Host Threads without persisting a second transcript.

## Goals / Non-Goals

**Goals:**

- Define a small Harness-neutral representation of Subagent delegation.
- Keep the representation extensible for future Harnesses without encoding Claude or Codex protocol types.
- Present Claude `Agent`/`Task` delegation as one native Codex collaboration Item.
- Hide nested Subagent Assistant, Reasoning, and Tool execution from the Root transcript.
- Correlate partial and complete Claude Assistant messages by native execution scope and native Assistant message identity.
- Preserve Root Turn completion semantics: a background launch acknowledgement is not a user-task terminal, and the Host Turn stays open until no Root Segment, background Subagent, or continuation is executing.
- Preserve autonomous Root continuations produced when Claude consumes a later background task notification, on the same Host Turn when that Turn is still held.

**Non-Goals:**

- Allow direct input to read-only Child Subagent Threads.
- Add wait, resume, or close Subagent commands to the common contract.
- Expose internal Subagent Tool calls or Assistant output in the Root timeline.
- Add a custom Renderer or change official Codex app-server protocol types.

## Decisions

### Represent delegation as a Host Item

Add `HostSubagentDelegationItem` to `HostItem`. It carries the operation (`spawn` in version one), the native correlation-safe Subagent identifiers, a bounded human description, optional role, optional public prompt, background flag, and each Subagent's current normalized state. Item updates replace the normalized Subagent set. This keeps lifecycle ordering inside the established Turn Item contract and lets existing Host Runtime routing remain unchanged.

The Host Runtime replaces native Subagent identities with stable Child Host Thread IDs before Protocol Core projection. Mapping Store persists the Parent Host Thread ID, native Subagent ID, role, and Child Host Thread ID, while transcript content remains owned by the Harness. Child Thread reads call the Adapter's optional Subagent history capability.

Harnesses that can resume work without a new desktop command emit `turn.autonomous.started` only when no Host Turn is still held for that user task. A continuation that belongs to a held Turn is projected as further Items on that Turn. Host Runtime creates a projector for a true autonomous Turn and persists its native identity normally.

### Keep capability reporting minimal

Add `subagents.observe`, `subagents.readTranscript`, and `autonomousTurns.observe` capabilities. Transcript reading is an Adapter-level operation because a Child Thread may be opened after its live parent Turn has completed.

### Keep Codex wire ownership in Protocol Core

Protocol Core maps `HostSubagentDelegationItem` to `collabAgentToolCall` with `tool=spawnAgent`. Host normalized states map to current Codex collaboration statuses. No Claude field or Codex field crosses into the other layer.

### Scope Claude messages by `parent_tool_use_id`

Root scope is represented by a null or absent `parent_tool_use_id`; every non-empty value is a nested execution scope. The accumulator processes Root Assistant streams and Root Tool lifecycle normally. Nested Assistant, stream, User Tool Result, and Tool Progress messages are consumed or ignored without emitting Root text, Reasoning, or Tool events.

Root stream state is keyed by native Assistant `message.id`. Stream wrappers use `event.message.id` from `message_start`; complete Assistant wrappers use `message.id`. Wrapper `uuid` remains checkpoint evidence and is never used to merge distinct Assistant responses. Tail events do not create a new active stream.

### Correlate Claude task notifications to delegation Tools

Root `Agent` and `Task` Tool Uses emit a specialized spawn delegation event. A `run_in_background` Tool Use occupies the user task by `callId` immediately; the structured Tool Result later binds the stable Claude `agentId`. An asynchronous launch acknowledgement completes the delegation Tool operation but leaves the native Agent running until its correlated task notification, which may settle by `agentId` or `callId`. `SendMessage` occupies the targeted Agent and remains running after the send operation succeeds. `task_started`, `task_progress`, `task_updated`, and `task_notification` refine correlated Agent state.

A Claude Root `result` or Assistant `message.completed` only means the current native Segment is idle. Claude answers for a settled background Subagent in a later Segment, and a task notification is therefore an edge that adds owed Root output rather than one that releases occupancy. Because the number of Segments Claude spends on the queued notifications is not observable, a notified Subagent is settled only after a bounded quiet period with no further Root output; Root text, reasoning, Tool Use, or a Segment start cancels that decision. Claude's `background_tasks_changed` level replaces the running set, so a tracked Subagent missing from the payload also owes its continuation even when its notification never arrives. The Adapter emits `turn.completed` only when that Segment has ended and no occupied background spawn from this user task remains unsettled. Continuations produced while the Turn is held stay on the same Host Turn. Host Runtime still tracks running Child Threads so Child status and Parent Thread active/idle stay accurate after the Turn finally completes.

When Claude emits a complete Result while no requested Host Turn is active, the Transport buffers that native continuation and delivers one autonomous Turn to the Adapter instead of dropping it.

Native history recovery uses the same classification: `origin.kind = task-notification` User records and complete `<task-notification>` wrappers are control-plane noise, not human Turns. After restart, their Root continuations remain on the preceding human Turn, and the XML is not projected as User input.

The Adapter publishes bounded description, role, background flag, normalized state, and the bounded user-authored prompt supplied to `Agent`, `Task`, or `SendMessage`. Claude internal launch metadata, transcript paths, and SDK task records remain private. The public prompt lets the native collaboration UI explain what work was delegated without exposing Child execution details in the Parent transcript.

## Risks / Trade-offs

- [Child Thread history may be unavailable after native cleanup] → Adapter history reads fail closed; Mapping Store contains identity and routing only, never transcript content.
- [Background continuation may race a requested Turn] → Autonomous continuations attach to a held user Turn; they start a new Host Turn only when no Turn is active. Overlapping native execution during a still-running requested Root Segment is treated as a protocol fault.
- [Claude versions vary in task notification richness] → Root Agent/Task Tool Use remains sufficient to create and complete one common delegation Item; task messages are optional refinements.
- [Filtering nested events could hide useful diagnostics] → Native details remain within Claude history and diagnostics; the Root user-facing transcript intentionally treats Subagents as opaque delegated work.
- [Adding a Host Item is a public union change] → Existing exhaustive projectors and test fakes are updated in the same change; unsupported Harnesses continue emitting no Subagent Items.
