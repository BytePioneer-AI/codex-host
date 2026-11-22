# External subagent presentation

External harnesses use the existing `subagentDelegation`/`HostSubagentState`
contract. The protocol projector renders it as native `collabAgentToolCall`
(`spawnAgent` or `sendInput`), with prompt, receiver thread IDs, agent states,
model and reasoning effort. Description and role already become the child
thread's `agentNickname` and `agentRole` through the Host materializer. No
renderer-specific card or parallel event protocol is required.

## Configuration policy

Native child configuration takes precedence, field by field. Optional string
`model`, `reasoningEffort`, `reasoning_effort`, and `thinking` values are consumed
when present. `model: "inherit"` requests the parent model, not a model literally
called "inherit". Unreported model/effort inherit the parent's selected session
configuration, decoded to the CLI's native model ID rather than exposing an
opaque Host model ref. Missing parent selections stay unknown; no hard-coded
model or effort is invented. The inherited values are presentation fallbacks,
not proof of the child's actual runtime settings.

Session boundaries apply the same policy to starts, state replacements,
completions and restored snapshots. A native value overrides a fallback on
later observations. The projector still returns null for the item-level
model AND effort when siblings have heterogeneous configurations; it never
labels a mixed group with the first receiver's configuration.

## Adapter audit

| Harness | Gap and source of native values |
| --- | --- |
| Antigravity | Previously dropped all configuration. Reads optional child info, supplies parent selections to its observer, and persists model/effort in the strict history schema. |
| Claude Code | Agent tool arguments and task updates previously lost configuration before lifecycle projection. Both now carry it; workflow children inherit when unreported. |
| CodeBuddy | Tool model and observed child transcript model existed; effort was lost. Reads native tool effort and observed child session effort. |
| WorkBuddy | Uses CodeBuddy's session/projection implementation, including the same policy and child transcript observations. |
| Cursor CLI | Task input and extension model existed; effort was dropped. Both sources now preserve configuration. |
| Grok | Model support existed, but tool reasoning effort and parent defaults were missing. Native tool inputs/updates and observed model bindings take precedence. |
| Kiro CLI | Task metadata supplied status/role but omitted prompt, configuration and child identity. Task cards now include these, pending state, and a parent-scoped read-only child summary. |
| Omp | Lifecycle/progress frames previously dropped configuration. Both now preserve native fields. |
| Pi | Workflow summaries already carried model/thinking. Versioned async widget leaves and gotgenes records now preserve optional configuration; sparse widget updates retain previously observed values. |
| ZCode | Native tool/session child records previously dropped configuration. Native result/data fields take precedence over input fields. |

For a restored snapshot whose native history does not expose per-child
configuration, the fallback is the parent's current selected session
configuration, not a reconstructed historical child selection. This limitation
is deliberate: the CLI did not provide evidence for a more precise value.

## Child transcripts and status

Existing native child identities and transcript readers remain unchanged.
Kiro's ACP does not expose the child's internal tool stream. Its read-only child
thread displays only the captured task prompt and result, with an explicit
unknown/running outcome until completion. The reader verifies the task belongs
to the requested parent (live cache or parent history); it never treats an
arbitrary task ID as another native session. Cancellation settles the child as
interrupted and invalidates the cached summary after publishing completion.
No CLI process is started to read a child, and no remote or user machines are
modified by this change.
