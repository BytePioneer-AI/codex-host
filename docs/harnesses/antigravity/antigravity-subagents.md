# Antigravity Subagent Projection

## Native Evidence

Validated with `agy 1.5.9` (`agy acp`):

- `invoke_subagent` and `send_message` arrive over ACP as `tool_call` / `tool_call_update` events carrying child conversation UUIDs in tool input or output (`subagent_id`, `agent_id`, `session_id`, `cascade_id`, or UUID text).
- Completing the `invoke_subagent` tool call finishes the spawn call, while background children may continue running independently.
- `~/.gemini/antigravity-cli/conversation_summaries.db` records each child conversation's `status` (`CASCADE_RUN_STATUS_RUNNING` / `CASCADE_RUN_STATUS_IDLE`) and `parent_conversation_id`.
- `~/.gemini/antigravity-cli/brain/<child-id>/.system_generated/logs/transcript.jsonl` records indexed user inputs, model responses, tool calls, and tool results for the child conversation.

## Projection

The Antigravity Adapter emits the standard `subagentDelegation`, `subagent.state.changed`, and `subagent.transcript.changed` contracts. The Host creates a read-only child Thread and projects `collabAgentToolCall` without Antigravity-specific Renderer or Host RPC extensions.

When `AntigravityToolTracker` observes `invoke_subagent` or `send_message` with a valid child UUID, `AntigravitySubagents` tracks the child against the parent's `nativeSessionId` and polls native storage read-only:

- Child run status is read from `conversation_summaries.db` after verifying `parent_conversation_id === parentId`. Rows owned by another conversation transition immediately to `interrupted` without reading `transcript.jsonl` or publishing `resultSummary`. Missing rows, transient SQLite read failures, or `CASCADE_RUN_STATUS_IDLE` with an unreadable transcript preserve `running` briefly and settle to `interrupted` after a 30-second observation timeout so polling stops cleanly, while confirmed `CASCADE_RUN_STATUS_RUNNING` stays active even if the transcript is missing or exceeds 8 MiB.
- Child progress and `subagents.readSnapshot` read only `~/.gemini/antigravity-cli/brain/<child-id>/.system_generated/logs/transcript.jsonl` (never arbitrary `log_uri` paths), rejecting symlinked directories and logs exceeding 8 MiB, and retrying incomplete trailing JSONL lines on subsequent reads.
- Only explicit user input, visible model responses, and tool calls/results are projected; internal thinking and injected system metadata are omitted from child conversation messages. Item and Turn IDs incorporate the native child identity so they remain stable across refreshes and Host restarts.

## Boundaries

- Child Threads are read-only; follow-up instructions go through the parent Session.
- `agy acp` is request-driven (`session/prompt`) and does not initiate unsolicited Autonomous Turns while idle; background child updates flow through `subagent.*` events, and `Session.hasBackgroundWork()` reports running children while they remain active. Note: the `codexhost_background` (`wait_for_background_task`) in-turn MCP server and `systemPrompt.append` wait guidance were removed so Turns can stop/finish and accept follow-up user input without blocking on background tasks.
- Idle agent output that agy emits between prompts (no `session/prompt` in flight) does not create a new Turn: the transport routes it to the Session handler and the adapter projects it as a background text Item (`item.background.started`) on the most recently completed user Turn. An Item settles when the output type changes, a successor Turn starts, the Session closes or faults, or switching into or out of Skip permissions restarts ACP. A Skip restart preserves the completed Turn's attribution window; `readSnapshot()` reads native history without settling the live Item. There are no timers, and `turn-N` keys, fork, and rollback are unaffected. Replay groups such output into the same Turn, and without a native messageId the answer and its idle tail merge into one consecutive text run there.
- Permission modes, `session/request_permission` approvals, and `elicitation/create` questions operate on the parent ACP Session.
- Missing, mismatched (`parent_conversation_id !== parentId`), or oversized (> 8 MiB) child logs return typed errors rather than empty fabricated transcripts.

## Validation

Focused unit tests cover `invoke_subagent` / `send_message` projection, read-only `conversation_summaries.db` status transitions, parent ownership checks, and `transcript.jsonl` parsing:

```bash
npx vitest run -c tests/vitest.config.js packages/adapters/antigravity/test/subagents.test.ts packages/adapters/antigravity/test/acp-projection.test.ts
```

Opt-in real CLI/Host integration (`CODEXHOST_RUN_ANTIGRAVITY_SUBAGENTS_REAL=1`) exercises live child delegation, `thread/turns/list`, stable IDs, restart/resume, and cancellation against a local `agy` installation:

```bash
CODEXHOST_RUN_ANTIGRAVITY_SUBAGENTS_REAL=1 npx vitest run -c tests/vitest.config.js packages/host-runtime/test/antigravity-subagents.real.test.ts
```

Official background: `https://antigravity.google/docs/cli/headless/` and `https://antigravity.google/docs/cli/subagents/`.
