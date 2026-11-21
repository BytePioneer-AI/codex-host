---
title: Remote Control
description: Drive agents on a remote Windows PC from another computer using a pairing code (Experimental).
---

# Remote Control

When your projects and agents are set up on a Windows PC and you want to drive them from another computer (such as a Mac laptop) without configuring SSH or port forwarding, use the experimental **Remote Control** mode.

It rides directly on Codex Desktop's official Remote Control channel:

- No open firewall ports or tunnels required.
- API keys, agent sign-ins, and project files stay on the target Windows PC.

## Prerequisites

- Install the **same CodexHost version** on both computers, and **launch Codex Desktop via `codexhost` on both sides**.
- Sign in to the ChatGPT account required by official Remote Control on both machines.
- Install and sign in to your target external agents (Claude Code, Pi, Grok, etc.) on the Windows PC.

## Connect

1. **On the target Windows PC**: Open Codex Desktop → **Settings → Connections → Control this computer**, enable access, and copy the **pairing code**.
2. **On your controlling computer**: Open Codex Desktop → **Settings → Connections → Control another device**, enter the pairing code, and select the Windows environment.
3. **Open a project**: Open a project directory on that Windows PC and select any of its installed agents from the bottom-right composer selector.

## Troubleshooting

- **Test a native Codex prompt first**: If a plain Codex prompt fails too, the official Remote Control session is disconnected—re-pair the two machines first.
- **Check how Windows launched Codex**: Codex Desktop on the Windows PC must be started through **`codexhost`**. Opening vanilla Codex Desktop directly does not load external agent support—quit completely and relaunch via `codexhost`.
- **Keep versions matched**: If you see an unknown-method error, run `codexhost update` on both computers and reconnect.

See [remote-control-host.md](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/platforms/remote/remote-control-host.md) for details.
