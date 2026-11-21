---
title: Delegation
description: "Spawn parallel child tasks across agents with # or hand off session context with @."
---

# Delegation

CodexHost lets agents delegate tasks and share context across tool boundaries. Unlike native subagents that stay locked to a single provider, CodexHost delegation can route work to any installed agent.

```text
Claude Code ──▶ #pi (debug flaky test)
Codex       ──▶ #claude-code (review diff independently)
Grok        ──▶ @-mention thread ──▶ Pi (pick up context and implement)
```

## Spawn parallel tasks with `#`

Type `#` in the composer, pick a target agent, and describe the task:

```text
Have #claude-code review this diff independently and flag any compatibility risks.

Have #pi track down why this unit test fails intermittently.

Have #omp implement the API endpoint while I finish wiring up the frontend form.
```

The child task uses the target agent's default model unless you specify a model or thinking level in your prompt.

### How child threads work

- **Full agent session**: Each delegated task opens a real thread under the target agent in the sidebar (nested under the parent thread in the Web UI) and runs in parallel without blocking your main conversation.
- **Inspect or step in anytime**: Click the child thread in the sidebar to watch tool calls, review diffs, or send follow-up prompts directly.
- **Automatic completion report**: When the child turn finishes, the parent session receives a notification and reads the final output.

## Hand off context with `@`

When an agent hits its quota mid-task, or when you finish researching with Grok and want Pi or Claude Code to write the code, reference the previous session with `@`:

1. Start a new thread with the target agent.
2. Type `@` in the composer to search for the previous thread (or **drag that thread from the sidebar into the composer**).
3. Ask the new agent to continue:

```text
Read how far this session got, pick up the context, and finish the remaining work.
```

The new agent reads the referenced thread's transcript on demand and can even send follow-up prompts to it directly.

## Isolate parallel edits with Git worktrees

When multiple agents edit the same repository at the same time, pass `--worktree <branch-name>` via the CLI or MCP `delegate_start` tool. CodexHost creates an isolated `.worktrees/` checkout and branch for each worker so files never collide.

See [CLI Reference](/en/docs/platform/cli) and [MCP Server](/en/docs/platform/mcp).
