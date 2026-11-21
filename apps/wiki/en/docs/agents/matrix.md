---
title: Capability Matrix
description: Supported native capabilities and runtime notes across preinstalled agents.
aside: false
---

# Capability Matrix

CodexHost connects to each agent through its native interface (RPC / SDK / ACP). Thinking levels, permission modes, slash commands, and context compaction map directly to what the underlying agent supports.

- **Edit Diff**: Summarizes file changes per turn in the right-hand Diff review panel.
- **Approvals / Permission Modes**: Prompts before commands or edits run, or switches session-level modes (Read-Only / Ask / Auto).
- **`#` Delegation**: Can run delegated subtasks in an independent child thread when targeted with `#`.
- **Fork**: Branches a new session starting from any earlier message in the thread.

::: info Info
`✅` Supported · `◐` Partial or conditional · `—` Not supported by the native interface
:::

## Supported agents

| Agent | Streaming | Tool Status | Edit Diff | Questions / Cancel | Model / Thinking | Approvals | Permission Modes | `#` Delegation | Usage | Fork | Compaction | `/` Commands | Edit Last Msg |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Pi** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Oh My Pi (OMP)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **OpenCode** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Grok** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **DSH (DeepSeek)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Antigravity (AGY)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| **CodeBuddy** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **WorkBuddy** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Cursor CLI** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | ✅ | ✅ |
| **Hermes** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Qoder / Qoder CN** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Kimi Code** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ |
| **Copilot** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Qwen Code** | ✅ | ✅ | — | ✅ | ✅ / — | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| **Devin CLI** | ✅ | ✅ | ✅ | — / ✅ | ✅ / ◐ | ✅ | ✅ | ◐ | — | ◐ | — | — | ◐ |

CodexHost also ships built-in adapters for **ZCode** and **Kiro CLI**—once installed locally, enable them from **Settings → Connections**.

## Agent notes

- **Pi**: Pi core does not define session-level permission modes, so no permission dropdown is shown. Native Pi extension prompts work normally, and a **Fast** toggle appears automatically on supported Codex models.
- **Cursor CLI**: Can delegate tasks outward to other agents, but **cannot receive unattended `#cursor` tasks from other sessions** (team policies can silently downgrade `--force`). Fork and edit-last-message are supported on macOS and Linux.
- **Antigravity (AGY)**: Requires `agy >= 1.5.8`. Supports `default`, `accept-edits`, `auto`, and `plan` permission modes, tool approvals, and question cards. Fork is available when the session is idle.
- **Kimi Code**: Thinking options update dynamically by model; supports exit-plan confirmation cards and `#` delegation.
- **Hermes**: Connects via the official Hermes Gateway; Fork and message editing work on history prior to context compaction.
- **WorkBuddy & ZCode**: Install and sign in to the desktop app (**WorkBuddy Desktop** / **ZCode Desktop**) first; CodexHost calls the bundled CLI directly.
