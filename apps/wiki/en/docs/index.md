---
title: Overview
description: What CodexHost is, how it works, and where its services and files live.
---

# Overview

CodexHost runs the coding agents you already use—Claude Code, Pi, Grok, OpenCode, DSH, Antigravity, and more—directly inside the official Codex Desktop app and a browser Web UI.

It does not bundle third-party agents or proxy model API calls. Instead, it drives the agent CLIs installed on your machine through their native interfaces. Every agent shares the same sidebar, Diff review panel, message Forking, and tool approvals, and can be driven from the CLI, MCP, or HTTP API.

## Quick start

```bash
npm install -g @codexhost/cli
codexhost          # Launch Codex Desktop (opens Web UI if Desktop isn't installed)
codexhost web      # Start the background Web UI and open 127.0.0.1:4400
codexhost stop     # Stop all background services
```

macOS and Windows installers are available on [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases). See [Installation](/en/docs/quick-start/install) for WinGet and service management.

## How it works

Codex Desktop, the Web UI, and the CLI all talk to one shared background Host process on your machine. Each thread belongs to a single Harness and communicates over its native protocol (RPC / SDK / ACP):

```text
  Codex Desktop ──┐                                    ┌──▶ Official Codex
  Web UI (:4400) ─┼──▶ CodexHost Runtime (:4398) ──────┼──▶ Claude Code / Pi / OMP
  CLI / MCP / API ┘    (Threads · Worktrees · Events)  └──▶ Grok / OpenCode / AGY ...
```

- **Not a custom chat clone**: Uses the unmodified official Codex Desktop shell (or the matching lightweight Web UI).
- **Bring your own accounts**: Each agent uses its own local login or API key; CodexHost never proxies model traffic.
- **Daemon lifecycle**: Closing the Desktop window or browser tab leaves running tasks alive in the background. Run `codexhost stop` to shut the Host down.

## Ports and local files

All local listeners bind to `127.0.0.1` by default, and local state lives under `~/.codexhost`:

| Port / Path | Purpose |
| :--- | :--- |
| `127.0.0.1:4400` | Web UI (`codexhost web`), synced live with Codex Desktop. |
| `127.0.0.1:4399` | Standalone diagnostics and settings console (`codexhost console`). |
| `127.0.0.1:4398` | Local orchestration HTTP API (`/v1/*`) and MCP server (`/mcp`). |
| `~/.codexhost/` | Thread mapping metadata, logs, and plugin settings. |
| `~/.codexhost/cli-credentials.json` | Short-lived `0600` credentials used by the local CLI. |

## Where next

- [Installation](/en/docs/quick-start/install) — native installers, npm, WinGet, updates, and login autostart.
- [Capability Matrix](/en/docs/agents/matrix) — supported features across all 18 preinstalled agents.
- [Delegation](/en/docs/agents/delegation) — spawn parallel child tasks with `#` or hand off context with `@`.
- [Web & Mobile](/en/docs/web/mobile) — pair a phone via QR code and enable push notifications.
- [Remote Hosts](/en/docs/remote/cross-machine) — run agents over SSH on Linux / macOS or via Windows Remote Control.
- [CLI Reference](/en/docs/platform/cli) — script agents from your terminal, MCP clients, or HTTP bots.
