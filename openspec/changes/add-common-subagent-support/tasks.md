## 1. Common Harness Contract

- [x] 1.1 Add shared Subagent observation capability and common delegation Item/state types to the public Harness contract.
- [x] 1.2 Extend Harness contract tests and testing utilities for the new capability and Item update.

## 2. Protocol Projection

- [x] 2.1 Project live and historical Subagent delegation Items as native Codex `collabAgentToolCall` Items.
- [x] 2.2 Add focused Protocol Core tests for start, state replacement, completion, and historical projection.

## 3. Claude Code Integration

- [x] 3.1 Refactor Claude native Assistant reconciliation to key Root responses by native scope and `message.id`, and ignore nested Subagent content for Root output.
- [x] 3.2 Add Claude transport events for Agent/Task delegation and validated task lifecycle refinements.
- [x] 3.3 Add a Claude Subagent delegation lifecycle that emits common Host Items and keeps nested Tools out of the Root Tool lifecycle.
- [x] 3.4 Advertise Claude Subagent observation and route delegation events through the Session.

## 4. Validation

- [x] 4.1 Add regression tests for interleaved Root text and nested Subagent Assistant/Tool messages without text conflict or duplicate output.
- [x] 4.2 Add Claude Adapter/transport tests for foreground and background Agent delegation lifecycle behavior.
- [x] 4.3 Run focused package typechecks and tests, then validate the OpenSpec change.

## 5. Child Threads and Background Continuation

- [x] 5.1 Persist stable Parent/Child Subagent bindings and project real Child Host Thread IDs.
- [x] 5.2 Add optional Adapter Subagent transcript reading and Claude `getSubagentMessages()` history mapping.
- [x] 5.3 Route read-only Child Thread metadata and paginated history through Host Runtime.
- [x] 5.4 Map Claude `SendMessage` to the existing Agent without treating send success as Agent completion.
- [x] 5.5 Preserve Claude autonomous Root continuations after background task notifications as follow-up Host Turns.
- [x] 5.6 Add regressions for Child Thread detail, SendMessage running state, and background continuation output.
- [x] 5.7 Project Child Host Thread active/idle status across SendMessage and correlated background task completion.
- [x] 5.8 Report Agent delegation as running from Tool Use, project live state replacements, and preserve Child Command/Tool history.
- [x] 5.9 Refresh already-open Child Threads from correlated nested Claude transcript changes and terminal history.
- [x] 5.10 Preserve stable Child history when Claude's official Subagent API omits the initial prompt or returns a partial transcript view.
- [x] 5.11 Restore omitted Child prompts from correlated Parent history and reopen the stable Child Turn before live Item publication.
- [x] 5.12 Preserve running state after asynchronous Agent launch, keep the Parent Thread active while background Children run, and refresh each Child on terminal notification.
- [x] 5.13 Project the bounded delegated prompt and converge terminal Child history across Claude transcript visibility delay.
- [x] 5.14 Keep the Host Turn open across background Subagents and their Root continuations until the user task is idle.
- [x] 5.15 Occupy background spawns at Tool Use, settle by `callId` or `agentId`, and emit `turn.completed` only after a Root Segment ends with empty occupancy.
- [x] 5.16 Keep a settled background Subagent occupying the user task until the native Session stops opening Segments, and observe Claude's live background task level.
