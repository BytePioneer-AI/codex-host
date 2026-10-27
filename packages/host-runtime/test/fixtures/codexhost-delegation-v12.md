---
name: codexhost-delegation
metadata:
  version: 12
description: >
  Delegate tasks to other coding agents, or read and follow up on existing
  agent sessions, including local or remote Threads identified by a codexhost
  cross-machine link. Use when the user asks another agent (including
  @agent) to independently perform a task, or asks to view a specified
  session's content, progress, or results, send follow-up messages, create,
  rename, archive, restore or delete Threads, wait, or cancel a task.
  Not for recapping the current conversation, discussing or
  configuring agents, or role-playing.
---

# Execute the task

Run the CLI through the executable in CODEXHOST_CLI_PATH. Before acting, run
help with the form for your shell:

- POSIX: `"$CODEXHOST_CLI_PATH" delegate --help`
- PowerShell: `& $env:CODEXHOST_CLI_PATH delegate --help`
- cmd: `"%CODEXHOST_CLI_PATH%" delegate --help`

If CODEXHOST_CLI_PATH is unset, try `codexhost`; if that also fails, tell the
user to add CODEXHOST_CLI_PATH to shell_environment_policy.include_only.
Commands shown by help and in `next` begin with `codexhost`; run them the
same way.

Use CLI help as the authoritative source for commands and behavior. Consult
command-specific help for options and the Harness listing command when the
target is unknown. Prefer compact output when supported, and use its task links
directly for subsequent commands.

Use the Harness native defaults. Inspect the target when a Model or Thinking
selection is needed or the default is unavailable.

For a new delegation, create an independent child session and submit the
requested task. Give it a short task name that tells it apart from sibling
tasks, using the help's task-name option. For an existing external session, resolve the target from the
user-provided session link, identifier, or context and operate on that Thread
directly; it need not have been created by the current assistant. If the target
is ambiguous, ask the user to identify it. Keep requests to view or summarize a
session read-only.

For a copied Thread link containing machineId, use CLI thread read with the
complete quoted link to inspect it, or thread send when the user requests a
follow-up message or continued execution. Preserve machineId, hostId and
pagination cursors in later reads. The machine identity determines the owner; hostId=local in a copied link
does not mean the machine running your session. Do not strip the identity or
substitute a local lookup when a remote read fails. Both machines must be
connected through an updated codexhost Desktop. Cross-machine send returns a
requestId. If its outcome is unknown, read the target or repeat the same message
and link with --request-id to recover the original receipt; never create a new
request ID to blindly retry an uncertain send. A send receipt confirms submission,
not task completion. THREAD_BUSY means read again later; do not interrupt the
current Turn without instruction. Cross-machine cancel, wait and watch are not
supported. A link alone is not an instruction to send a message.

To create an independent Thread on another machine, use thread create --on
with a complete copied link from that machine and --cwd with an absolute path
on that machine. The link selects the destination; its source Thread is unchanged.
Alternatively use --machine with a known machine identity. Omit both for the
calling machine. Choose --harness only when requested; the default is codex.
Create returns an idle Thread link: use thread send to submit its first task.
Use thread rename --name, thread archive, thread unarchive, and thread delete
with the complete target link. Permanent deletion requires explicit user intent
and --confirm permanent; never interpret a request to archive as permission to
delete. Operate only on the identified target. Lifecycle commands return a
requestId; recover uncertain outcomes by repeating exactly the same command
with that ID, never by issuing a fresh create or delete. Native permissions and
busy-session restrictions apply; these commands do not grant network access.

For a new or existing task, choose the appropriate next action based on the
user’s request and the task:

- send a follow-up message to the same Thread;
- cancel its current Turn;
- read its current state immediately;
- wait for a bounded period;
- check it again later;
- watch it, so the Host notifies this Thread once when the watched Thread stops
  and no waiting or polling is needed meanwhile;
- leave it running in the background.

A watch notification reports execution state only. Read the Thread before
judging or reporting its work.

Report the result returned by read or a completed wait, together with the target
agent, status, and a labeled task link. Keep internal tracking IDs in tool calls.
