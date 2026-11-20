---
title: Installation
description: Install CodexHost and manage the desktop app, web UI, and background daemon.
---

# Installation

Three ways to install CodexHost: native installer, npm CLI, or WinGet.

## Install

### Native installer (macOS / Windows)

Download the installer for your platform from [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases) (`.dmg` / `.pkg` on macOS, `.exe` on Windows).

Open **`codexhost`** to launch Codex Desktop. To use the Web UI locally, visit `http://127.0.0.1:4400`.

### npm (macOS / Windows / Linux)

Requires **Node.js 22.19+** or **Node.js 24** (Node 23.x is not supported):

```bash
npm install -g @codexhost/cli
```

Common commands:

```bash
codexhost          # Launch Codex Desktop (opens Web UI if Desktop isn't installed)
codexhost web      # Start the background Web UI and open 127.0.0.1:4400
codexhost status   # Check running services, versions, and autostart state
codexhost stop     # Stop all CodexHost background services
```

### WinGet (Windows x64 / ARM64)

Use the same command in PowerShell to install or upgrade:

```powershell
winget install --id BytePioneer-AI.CodexHost --exact
```

## Prerequisites

| Surface | Requirement |
| :--- | :--- |
| **Desktop UI** | Official **Codex Desktop** installed on your machine. |
| **Web / Mobile UI** | **No** Codex Desktop required; run `codexhost web` directly. |
| **External Agents** | Install and sign in to the agent CLIs you use (`claude`, `pi`, `grok`, etc.), or install them from **Settings → Connections**. |

## Updates, stopping, and login autostart

```bash
codexhost update            # Upgrade to the latest release
codexhost stop              # Stop Desktop, Web, Host, and Console processes
codexhost autostart on      # Start automatically at OS login
codexhost autostart off     # Disable login autostart
codexhost autostart status  # Check autostart state
```

- **Manual npm reinstall**: Run `codexhost stop` before overwriting an existing installation with `npm install -g`.
- **Data preservation**: `codexhost stop` interrupts active turns but never deletes chat history, workspace files, or configuration.

## How Desktop and Web share sessions

Codex Desktop and the Web UI (`127.0.0.1:4400`) connect to the same background Host on your machine.

Sessions, tool approvals, and active turns live in the Host. Closing the Desktop window or browser tab does not stop running work—you can start a task on Desktop, close the window, and monitor or approve it from your phone.

## Where next

- [Accounts & Usage](/en/docs/quick-start/accounts-usage) — check quotas across tools and import credentials into Pi.
- [Troubleshooting](/en/docs/quick-start/troubleshooting) — diagnose startup issues with `codexhost console` (port `4399`).
- [Web & Mobile](/en/docs/web/mobile) — connect your phone via QR code.
