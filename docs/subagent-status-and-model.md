# Subagent status, Model, and reasoning effort

The Subagent list shows a subtitle in the order `status · Model · reasoning effort`, for example `已完成 · Grok 4.6 · High`. It supports waiting, running, completed, failed, and interrupted states. Missing Model or effort values are omitted.

## Native Codex

The renderer supports existing child rows and collapsed `subAgentActivity` rows, preserving child names and seed avatars. It reads the exact child Thread for Model, reasoning effort, and terminal status. It never substitutes the parent Composer Model for an unknown child Model. Saved parent activities restore the list when a Thread is reopened.

Reads are deduplicated and cached, with bounded retries. Renderer observation is debounced and avoids responding indefinitely to its own DOM updates. This integration depends on Desktop row bindings and its request bridge; a Desktop update can require binding changes.

## Grok

The Adapter projects native spawn/task tools into Host Subagent delegation items and exposes child transcripts through the public Subagent capability. Native completion events, single-result waits, multi-result waits, and kill results settle child states. A completed spawn tool alone does not mean its background child has completed.

Grok Model labels use explicit spawn metadata when available and the session selection as a fallback; reasoning effort comes from the parent session setting. These fallback values are not independent verification of a child's inference configuration.

New Grok sessions receive the requested startup Model. Switching Models updates native identity metadata, and each Turn carries an active-Model reminder. This changes native prompt/history identity text and should be reviewed separately from display-only changes; self-reported identity is not proof of the backend Model.

## Validation scope

Focused tests cover Grok tool/event projection, history, Model startup/reminders, native Codex child identity checks, status handling, cached reads, and history restoration. The local macOS Desktop UI was inspected for completed and failed child subtitles. Waiting and interrupted states have automated coverage but were not reproduced live. Windows and Linux live UI validation is outstanding.
