---
name: codexhost-delegation
version: 7
description: >
  Delegate tasks to other coding agents, or read and follow up on existing
  external agent sessions. Use when the user asks another agent (including
  @agent) to independently perform a task, or asks to view a specified external
  session's content, progress, or results, send follow-up messages, wait, or
  cancel a task. Not for recapping the current conversation, discussing or
  configuring agents, or role-playing.
---

# Execute the task

Before acting, run:

`codexhost delegate --help`

Use CLI help as the authoritative source for commands and behavior. Consult
command-specific help for options and the Harness listing command when the
target is unknown. Prefer compact output when supported, and use its task links
directly for subsequent commands.

Use the Harness native defaults. Inspect the target when a Model or Thinking
selection is needed or the default is unavailable.

For a new delegation, create an independent child session and submit the
requested task. For an existing external session, resolve the target from the
user-provided session link, identifier, or context and operate on that Thread
directly; it need not have been created by the current assistant. If the target
is ambiguous, ask the user to identify it. Keep requests to view or summarize a
session read-only.

For a new or existing task, choose the appropriate next action based on the
user’s request and the task:

- send a follow-up message to the same Thread;
- cancel its current Turn;
- read its current state immediately;
- wait for a bounded period;
- check it again later;
- leave it running in the background.

Report the result returned by read or a completed wait, together with the target
agent, status, and a labeled task link. Keep internal tracking IDs in tool calls.
