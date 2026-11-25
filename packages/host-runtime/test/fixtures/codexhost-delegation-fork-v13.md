---
name: codexhost-delegation
version: 13
description: >
  Delegate tasks to other coding agents, or read and follow up on existing
  external agent sessions. Use when the user asks another agent (including
  @agent) to independently perform a task, or asks to view a specified external
  session's content, progress, or results, send follow-up messages, answer its
  questions, wait, or cancel a task. Not for recapping the current conversation, discussing or
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

When users want delegation in another app, suggest the external CLI, HTTP or MCP.
The running Host saves private local credentials in ~/.codexhost/cli-credentials.json
(or the configured data directory); same-user CLI calls read them automatically.
HTTP/MCP clients can use that token in Authorization: Bearer <token>.
For a separate client identity, run `codexhost client add <name>` and store the
returned token privately. Host-started sessions keep their injected credentials.

Use the Harness native defaults. Inspect the target when a Model or Thinking
selection is needed or the default is unavailable.

For a new delegation, create an independent child session and submit the
requested task. Give it a short task name that tells it apart from sibling
tasks, using the help's task-name option. When the change is large, or several
delegated tasks run in parallel and may touch the same files, an isolated git
worktree for the child is an option; help shows how to request one. For an existing external session, resolve the target from the
user-provided session link, identifier, or context and operate on that Thread
directly; it need not have been created by the current assistant. If the target
is ambiguous, ask the user to identify it. Keep requests to view or summarize a
session read-only.

For a new or existing task, choose the appropriate next action based on the
user’s request and the task:

- send a follow-up message to the same Thread;
- cancel its current Turn;
- read its current state immediately;
- answer a Question the Thread is waiting for;
- wait for a bounded period;
- check it again later;
- watch it, so the Host notifies this Thread once when the watched Thread stops
  or waits for an answer, and no waiting or polling is needed meanwhile;
- leave it running in the background.

A delegated Thread may ask a Question while its Turn is still running. Native
asynchronous questions let the Agent keep working. `thread read` reports
`pendingQuestions` with an opaque interaction ID, the Turn, `kind`, and native
question data in `request`; an empty list means none. Reading and answering need no watch.

Answer with `thread answer <thread> --interaction <id> --answers-file <file>`.
For `kind: requestUserInput` (also the default for older Runtimes), the file contains
the existing reply result, for example `{"answers":{"decision":{"answers":["Continue"]}}}`.
For `kind: requestUserInputAsync`, each entry is one question: read `request.title`
and `request.options`, then submit `{"answer":"Continue"}`. Other questions remain
pending; an ended Turn cannot receive a late answer. Use the prompts and option
labels in the reported request. The existing handler owns reply interpretation,
cancellation, and invalid-input behavior. Read again before retrying a failed
reply. After answering, watch again or read for the outcome; submission does not
prove the work succeeded. A Question the user must decide, and anything outside the task authorization,
belongs to the user rather than to you.

A watch notification can report that the watched Thread needs input
(`needsInput`), naming the request and Turn, and it may also report
`alreadyNeedsInput` or `alreadyTerminal` at registration. It reports execution
state only. Read the Thread before judging or reporting its work.

Only when debugging needs the full Thread, export it to a file; help shows how.

Report the result returned by read or a completed wait, together with the target
agent, status, and a labeled task link. Keep internal tracking IDs in tool calls.
