# Antigravity Subagent Projection

## Native Evidence

Validated with agy 1.1.27 on Windows:

- `invoke_subagent` produces `step_type: "subagent"` with
  `subagent_info.subagents`. Each child includes `conversation_id`, `type_name`,
  `role`, `initial_prompt`, and `log_uri`.
- Both ACTIVE and DONE can include this metadata. DONE completes the spawn
  operation, not the background child.
- The local Language Server's `GetCascadeTrajectory` returns a separate
  `CASCADE_RUN_STATUS_RUNNING` / `CASCADE_RUN_STATUS_IDLE` status and
  `trajectory.metadata.parentConversationId`.
- The native `transcript.jsonl` contains indexed user input, model responses,
  tool calls, and tool results.

## Projection

The Antigravity Adapter emits the existing `subagentDelegation`,
`subagent.state.changed`, and `subagent.transcript.changed` contracts.
The common Host creates a read-only child Thread and the common projector emits
`collabAgentToolCall`. No Antigravity-specific Renderer or Host RPC is added.

The creation Item completes when the native spawn call completes. Its child
remains running until the separate native status confirms otherwise. During an
active parent Turn, existing children are also observed, including children
contacted again after resume. A transient RPC failure never means completion.

Child progress is refreshed from completed native log entries. Only explicit
user input, visible responses, and tool output are projected; internal thinking
and injected system metadata are not exposed as conversation messages.
Item and Turn IDs include the native child identity and remain stable across
reads and Host restarts. Parent history retains the latest observed child state.

Transcript lookup validates the child ID and its recorded relationship to the
parent. It reads only the child's fixed native log location, rejects redirected
paths and oversized logs, and retries an incomplete trailing JSON line on a
later read. The event's `log_uri` is never used as an arbitrary file read target.

Cancellation requests stop the parent generator and owned running children via
the native cancellation RPC before CLI shutdown. If native cancellation cannot
be confirmed, the result explicitly reports interrupted observation instead of
claiming successful native cancellation.

## Boundaries

- Child Threads are read-only. Further instructions go through the parent.
- This does not enable Autonomous Turns or child-specific Questions.
  The optional Desktop approvals mode can route Hook requests from registered
  direct children through the active parent Turn; unknown children are rejected.
  The Question bridge remains scoped to the parent Turn.
- If a parent result arrives while children are still running, the observer and
  CLI stay alive until they settle or the Session closes. New parent input is
  rejected as busy during that interval.
- Native Language Server methods and log shapes are compatibility-sensitive.
  Missing or invalid child history returns a typed error, never fabricated
  successful history. Logs above 8 MiB are explicitly unsupported.
- Native CLI/Host protocol verification is not a visual Desktop acceptance test.

## Validation

On 2026-09-05, the user confirmed Desktop rendering with a screenshot showing
the creation step, completed child status, and child entry in the side panel.
This confirms those visual surfaces, not a manual test of every child interaction.

Focused parser/lifecycle checks:

```text
node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js packages/adapters/antigravity/test/subagents.test.ts
```

Opt-in real CLI/Host integration (uses the locally configured Antigravity account):

```powershell
$env:CODEXHOST_RUN_ANTIGRAVITY_SUBAGENTS_REAL = "1"
node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js packages/host-runtime/test/antigravity-subagents.real.test.ts
```

The real test uses a private workspace and Mapping Store. It checks native card
projection, live child progress, `thread/turns/list`, stable IDs, restart/resume,
follow-up contact, and cancellation. Optional evidence output is controlled by
`CODEXHOST_ANTIGRAVITY_SUBAGENTS_EVIDENCE_DIR`; do not commit those runtime logs.

Official background: `https://antigravity.google/docs/cli/headless/` and
`https://antigravity.google/docs/cli/subagents/`.
