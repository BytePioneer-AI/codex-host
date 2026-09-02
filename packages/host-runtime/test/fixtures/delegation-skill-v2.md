---
name: codexhost-delegation
version: 2
description: >
  Delegate work to another coding agent. Use when the user explicitly asks
  Claude Code, Pi, Codex/OpenAI, OMP, Grok, another agent, or an agent mentioned
  as @<agent> to independently review, investigate, implement, test, or verify
  something. Do not use when the user is merely discussing, comparing, or
  configuring agents, choosing a Model or Provider, or asking the current agent
  to role-play as another agent.
---

# Execute the task

Before acting, run:

`codexhost delegate --help`

Treat its output as the sole authoritative source for:

- available commands;
- command parameters;
- available target Harness IDs;
- Thread identifier formats;
- waiting and reading behavior;
- response fields;
- errors and recovery guidance.

Do not construct commands, parameters, or Harness IDs from memory.

Create an independent child session and submit the requested task.

After starting the task, choose the appropriate next action based on the
user’s request and the task:

- read its current state immediately;
- wait for a bounded period;
- check it again later;
- leave it running in the background.

When the result is needed, explicitly read the child Thread. Report only the
visible result returned by that Thread.

Provide the user with the necessary tracking information, including:

- target agent;
- `delegationId`;
- `threadId`;
- `turnId`;
- `deepLink`;
- current or final status.
