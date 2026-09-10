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

## Session configuration

New Grok Sessions receive an explicitly requested startup Model through the native `--model` flag. Subsequent changes continue to use `session/set_model`. codexhost does not rewrite `system_prompt.txt`, `prompt_context.json`, or `chat_history.jsonl` to change Model identity, and does not append identity reminders to user Turns.

## Validation scope

Focused automated tests cover tool/event mapping, lifecycle projection, child transcript reads, history replay, explicit versus unknown child Model metadata, startup arguments, unchanged user input, and native protocol projection for missing and heterogeneous configurations. These checks do not replace live Grok/Desktop validation; the removed custom UI screenshot is not evidence for this native-only version.
