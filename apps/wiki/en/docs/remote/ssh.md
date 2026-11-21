---
title: SSH Host
description: Connect local Codex Desktop to a remote Linux or macOS server over SSH.
---

# SSH Host

When your codebase, build toolchain, and signed-in agent CLIs (such as Claude Code or Pi) live on a remote Linux or macOS machine, SSH mode lets you chat, review diffs, and approve commands in your local Codex Desktop while all agents and file edits run on the remote server.

## Prerequisites

1. **Local computer** (macOS, Windows, or Linux): Codex Desktop launched via `codexhost`.
2. **Remote machine**: Must run **Linux or macOS** (Windows is not supported as an SSH target), with **Node.js 22.19+ or 24**, npm, official Codex CLI, and your target agent CLIs installed and signed in.
3. **Key-based SSH access**: Run `ssh user@host` once in your local terminal to verify key authentication and accept the host fingerprint (the UI uses your SSH keys and `~/.ssh/config` aliases without password prompts).

## One-click install & connect from Settings (Recommended)

1. In local Codex Desktop, open **codexhost Settings → Remote Connections** and click **Add Connection** (hosts already added under official **Settings → Connections → SSH** appear automatically).
2. Enter a name and the SSH target (`user@host` or SSH config alias), then click **Save**.
3. Click **Install & Connect**. CodexHost installs the matching remote service version over SSH and connects automatically.
4. Once it shows **Connected**, open a project directory on that remote server in Codex Desktop and pick any remote agent from the bottom-right selector.

After updating CodexHost locally in the future, revisit **Remote Connections** and click **Update to Local Version**.

## Manual CLI setup on the remote host

If you prefer setting up the remote host from a terminal, make sure both machines use the same CodexHost version and run on the server:

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

### Remote macOS: Accessing Login Keychain credentials

Standard SSH sessions on macOS sometimes cannot read credentials stored in the macOS login keychain (such as `gh` CLI tokens). As long as the same user stays logged in on the remote Mac's desktop, switch the remote service to desktop session mode:

```bash
codexhost remote stop
codexhost remote install --session desktop
codexhost remote start
```

See [remote-ssh-host.md](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/platforms/remote/remote-ssh-host.md) for advanced maintenance and troubleshooting.
