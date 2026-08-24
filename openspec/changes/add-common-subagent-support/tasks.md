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
