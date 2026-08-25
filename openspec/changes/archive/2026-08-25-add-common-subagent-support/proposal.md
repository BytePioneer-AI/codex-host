## Why

Harnesses increasingly expose delegated Subagent work, but codexhost currently flattens that work into ordinary Tool and Assistant events. This both prevents reuse of Codex Desktop's native multi-Agent presentation and, for Claude Code, allows nested Assistant streams to corrupt the Root Agent response lifecycle.

## What Changes

- Add UI-independent Host semantics for a Turn-scoped Subagent delegation and the delegated Agent's stable identity and lifecycle.
- Add optional Subagent capability reporting to Harness Sessions so future Adapters can adopt the same contract without exposing native protocol fields.
- Project Host Subagent delegations into Codex app-server's native `collabAgentToolCall` Thread Item.
- Integrate Claude Code's Agent/Task Tool calls and task lifecycle notifications with the common Subagent contract.
- Isolate Claude Root Assistant streams and Tools from nested Subagent streams and Tools, hiding nested execution details from the Root transcript.
- Register stable read-only Child Host Threads for Subagents so Codex Desktop can open the native right-side conversation detail and restore it from Harness-owned history.
- Preserve Harness-generated autonomous Root continuations after background task notifications on the same Host Turn while that user task is still held, and as follow-up Host Turns only after the requested Turn has already completed.

## Capabilities

### New Capabilities
- `harness-subagent-session`: Common Host Subagent identity, delegation, lifecycle, capabilities, ordering, and Codex native projection.

### Modified Capabilities
- `claude-code-text-session`: Claude Code must map native Subagent activity to the common contract and isolate nested streams from Root Turn output.

## Impact

- Public TypeScript contracts in `packages/harness-adapter` and `packages/shared-contracts`.
- Claude Code native message parsing, transport events, Tool lifecycle mapping, and focused tests.
- Protocol Core Item projection and tests.
- Host Runtime and Mapping Store gain persisted Parent/Child Subagent bindings and read-only Child Thread routing.
- Harness Sessions may emit autonomous Turn starts when the native Harness resumes work without a new desktop request.
