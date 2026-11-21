---
title: CLI Reference
description: List agents, spawn tasks, read transcripts, and steer threads from your terminal.
---

# CLI Reference

Whenever CodexHost is running locally (via Codex Desktop or `codexhost web`), the Host writes short-lived `0600` credentials to `~/.codexhost/cli-credentials.json`. Any terminal or script under the same OS user can run `codexhost` commands immediately without tokens or environment variables.

::: info Info
Orchestration subcommands do not auto-start the Host; make sure Codex Desktop or `codexhost web` is already running.
:::

## Quick reference

```bash
codexhost harness list --format text                             # List available agents
codexhost project list --format text                             # List local Git repos
codexhost delegate start --harness pi --task "fix failing test"  # Spawn a new thread
codexhost thread wait <thread-id> --format text                  # Wait for the active turn
codexhost thread read <thread-id> --view messages --format text  # Read per-turn messages
codexhost thread send <thread-id> --message "add edge cases"     # Send follow-up prompt
codexhost thread cancel <thread-id>                              # Cancel the active turn
```

## Spawn a task (`delegate start`)

Start a new agent thread in the current repo or an isolated Git worktree:

```bash
codexhost delegate start \
  --harness claude-code \
  --task-name "Audit auth boundaries" \
  --worktree review/auth \
  --watch true \
  --format text \
  --task "Review permission boundaries in packages/host-runtime and suggest concrete fixes."
```

Common flags:

- `--worktree <branch>`: Creates `<branch>` under `.worktrees/` and runs the agent in that checkout.
- `--watch true`: Records a completion event when the turn finishes (and notifies the parent session when called by another agent).
- `--task-file -`: Reads multi-line prompts from stdin (pipe or `<<'EOF'`) without shell quoting issues.

Returns the new `<thread-id>` immediately and shows the thread in your Desktop and Web sidebars.

## Wait and read output (`thread wait` / `thread read`)

```bash
# Wait until the turn finishes (defaults to 30s; returns a live status snapshot on timeout without stopping it)
codexhost thread wait <thread-id> --format text

# Read the latest turn summary
codexhost thread read <thread-id> --view result --format text

# Read per-turn user prompts and final agent replies (supports --from 1 --to 10 pagination)
codexhost thread read <thread-id> --view messages --format text
```

## Follow up, steer, or interrupt (`thread send` / `thread cancel`)

```bash
# Send a follow-up when the thread is idle
codexhost thread send <thread-id> --message "Add unit tests for those cases too"

# Nudge a running thread mid-turn without cancelling it
codexhost thread send <thread-id> --steer true --message "Focus only on host-runtime for now"

# Cancel the active turn, wait for it to stop, and immediately submit new instructions
codexhost thread send <thread-id> --interrupt --message "Stop that—trace the startup flow instead"

# Cancel the active turn only (keeps the thread and transcript intact)
codexhost thread cancel <thread-id>
```

## Output formats (`--format`)

All orchestration commands accept `--format`:

- `text`: Clean plain text for human reading or feeding directly into another LLM.
- `compact`: Concise JSON with task deep links for shell scripts.
- `json` (default): Full structured JSON response.
