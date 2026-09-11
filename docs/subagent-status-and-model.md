# Grok Subagents and native Desktop projection

## Scope

The Grok Adapter maps native spawn/task tools to the existing Host `subagentDelegation` contract. Desktop receives the existing `collabAgentToolCall` projection and remains responsible for its Subagent list, collapse behavior, navigation, and visual presentation.

This integration does not inject a replacement list, custom status subtitles, avatars, or a history panel. It does not inspect React Fiber, add child `thread/read` requests, or scan and rewrite official Codex protocol frames. Native Codex Subagent behavior is unchanged.

## Lifecycle and transcripts

- Spawn/send tools expose child identity, description, role, background execution, and status through the public Subagent contract.
- A completed background spawn tool does not mean the child has completed. Observed native completion events, terminal wait results, and successful kill tools settle child states. A failed kill tool does not imply that the child stopped.
- Child transcripts are read-only snapshots of the child Native Session; they are not separate writable Host Sessions.
- Parent Native history is projected back into Subagent Items when the Thread is reopened. Presentation uses the existing Desktop history path rather than a Renderer-maintained copy of the list.

## Model and reasoning effort

The public `HostSubagentState` has optional `model` and `reasoningEffort` fields. Adapters must omit unknown values rather than infer them from parent Session settings.

Grok supplies the raw child Model ID when explicitly present in spawn arguments or a native spawned event. A reported child Model supersedes the spawn argument. An explicit argument describes the requested child configuration; it is not independent verification of the inference backend. Grok does not currently supply independently observed child reasoning effort, so that field is omitted.

The protocol projector passes these values in separate native `model` and `reasoningEffort` fields without formatting an ID into a display label. Since a native collaboration Item has only one configuration slot, a multi-child Item supplies it only when all children have the same configuration. Missing or heterogeneous configurations are not guessed. Adapters that omit both optional fields retain the previous null projection.

Whether and where those fields are visible depends on the installed Desktop version; this integration does not promise a custom `status · Model · effort` subtitle.

## Summary panel discovery and restored identity

The native Desktop summary panel discovers descendants through `thread/list`
with `ancestorThreadId` (or `parentThreadId` on older app-server versions) and
`sourceKinds: ["subAgentThreadSpawn"]`. Host serves persisted external child
metadata for these scoped queries, including `useStateDbOnly`, without opening
child Harness Sessions or reading their transcripts. Ordinary unscoped task
lists still omit native subagents unless a subagent source kind is requested.

Live child state comes from observed native subagent lifecycle events even if
the child transcript has never been opened. After Host restart, an unobserved
child remains `notLoaded` until a real status observation is available.

Live projection and parent history hydration reuse the same child Host Thread
identity. Historical collaboration Items carry their parent Host Thread ID and
resolved child receiver IDs, rather than raw CLI-native IDs. This also recovers
children from history recorded before the Host had materialized them. Existing
child mappings retain their IDs; concurrent hydration and live events cannot
create duplicate children for one parent Native Session and native child ID.

When rollback replaces the Native Session of the same Host Thread, children
retained in the validated rollback snapshot (and their materialized descendants)
are rebound to that replacement without changing their Host Thread/Turn IDs.
Native references and the indexed creation key change together. Cached read-only
child Sessions are retired so subsequent reads use the replacement parent, even
if a child read was already in flight. Metadata discovery excludes descendants
still bound to an older parent Native Session. This does not merge fork children
with source children or reuse a removed child's Host identity when a new Native
Session later reuses its native child ID. In-place rewind needs no rebinding.

Ordinary hydration uses the existing creation-request index. Legacy records need
at most one shared metadata scan per snapshot; rollback also shares that scan
when locating materialized descendants. Repeated reads of indexed child mappings
do not clone the entire MappingStore for each child.

These paths are shared by CodeBuddy, Cursor, Grok, Claude Code, Antigravity and
other Adapters using `subagentDelegation`. Cursor's lack of an internal child
message/tool stream does not prevent summary list discovery and lifecycle
display; only confirmed native information is projected.

## Session configuration

DeepSeek Harness `0.1.2-rc.1` and `0.1.5-rc.1` now use the same native collaboration and read-only child Thread paths for their default session-backed subagents. Version-specific discovery, ancestry checks, background lifecycle and provider limits are documented in [DSH native subagents](dsh-subagents.md).

New Grok Sessions receive an explicitly requested startup Model through the native `--model` flag. Subsequent changes continue to use `session/set_model`. codexhost does not rewrite `system_prompt.txt`, `prompt_context.json`, or `chat_history.jsonl` to change Model identity, and does not append identity reminders to user Turns.

## Validation scope

Focused automated tests cover tool/event mapping, lifecycle projection, child transcript reads, history replay, explicit versus unknown child Model metadata, startup arguments, unchanged user input, native protocol projection for missing and heterogeneous configurations, rollback child/descendant identity rebinding, in-flight read retirement, reused native IDs, fork isolation, and indexed/legacy metadata lookup costs. These checks do not replace live Grok/Desktop validation; the removed custom UI screenshot is not evidence for this native-only version.
