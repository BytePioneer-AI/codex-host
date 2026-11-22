---
title: Overview
description: Drive all CodexHost agents from shell scripts, MCP clients, or external bots.
---

# Overview

Whenever CodexHost is running locally (via Codex Desktop or `codexhost web`), the background Host exposes its orchestration surface on `127.0.0.1:4398`. Shell scripts, Claude Desktop, Cursor, and Slack / Telegram / Feishu bots can spawn agent threads, isolate Git worktrees, steer active turns, and consume completion events.

## Choose an interface

| Use case | Interface | Auth | Guide |
| :--- | :--- | :--- | :--- |
| **Shell / Python scripts** or agent-to-agent calls under your OS user | **CLI** | **Zero config** (auto-reads `~/.codexhost/cli-credentials.json`) | [CLI Reference](/en/docs/platform/cli) |
| Calling CodexHost agents from **Claude Desktop, Claude Code, or Cursor** | **MCP Server** | Client token (`codexhost client add`) | [MCP Server](/en/docs/platform/mcp) |
| **Always-on bots (Slack / Telegram / Feishu)**, webhooks, or backend services | **HTTP API + Events** | Client token (`codexhost client add`) | [HTTP API](/en/docs/platform/http-events) |

## Shared behavior

All three interfaces share the same Host execution model:

- **Visible in the UI**: Every thread started from the CLI, MCP, or HTTP appears live in your Desktop and Web sidebars. Click in anytime to review diffs, approve commands, or take over by hand.
- **Git worktree isolation**: Pass `worktree` (or `--worktree`) when starting a task to create an isolated branch under `.worktrees/` so parallel agents never overwrite each other's files.
- **Mid-turn steering & interrupts**: Nudge a running agent mid-turn (`steer`), or cancel the active turn and immediately send new instructions (`interrupt`).
- **7-day completion event log**: Enabling `watch` records completion events in a persistent per-client log so bots and scripts can resume after restarts without missing results.
