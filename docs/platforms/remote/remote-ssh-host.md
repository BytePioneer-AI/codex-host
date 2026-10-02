# Remote Harnesses over SSH

Use Harnesses that are installed and signed in only on a remote machine — Claude Code included — from your local Codex Desktop, through its native SSH workspace. Your credentials stay on the remote machine and are never sent over SSH.

## Prerequisites

- **Local machine** (macOS, Linux, or Windows): Codex Desktop and codexhost are installed.
- **Remote machine** (macOS or x64/ARM64 Linux; Windows isn't supported yet): Codex CLI is installed, along with **the same codexhost version** as your local machine.
- The Harness you want to use is installed and signed in on the remote machine.
- Codex Desktop's native SSH workspace already works (**Settings → Connections → SSH**).

## Install

On the remote machine, run:

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

Installation automatically backs up any shell configuration it needs to change. On macOS, keep a user logged in to the remote desktop so Claude Code can start normally.

## Usage

1. On your local machine, launch Codex Desktop through codexhost.
2. Open the SSH workspace.
3. Pick a Harness from the composer's Agent / Model selector.

You can use local and SSH workspaces at the same time, choosing the Harnesses and models available on each machine. If you only use native Codex remotely, the remote machine does not need codexhost.

## Viewing and operating the same conversation on both computers

Install Codex Desktop on the remote machine too, and launch it through codexhost. While the remote service is running, external Harness conversations created in the SSH workspace automatically appear in the remote machine's conversation list. They may take a few seconds to appear initially.

Both computers need the same codexhost version. On the remote machine, use the same user account for the desktop and SSH login. If you customized the Codex data directory (`CODEX_HOME`), both launch methods must use that directory.

- **See updates on both computers**: both show user messages, replies as they arrive, tool activity, and task status.
- **Act from either computer**: send or insert messages, interrupt a task, or answer approvals and questions without switching control.
- **Act at the same time**: use the insert-message feature to add input during a running task; starting another task may return a busy message. When both computers answer the same approval or question, the first processed answer applies.
- **Recover after disconnecting**: as long as the remote service stays running, disconnecting one computer does not stop the task. Reconnect and reopen the conversation to see what happened while you were away. Stopping the remote service ends running tasks.
- **Check before resending**: if a disconnection leaves you unsure whether a message was sent, reconnect and check the conversation before sending it again.

This feature applies to external Harness conversations created in the SSH workspace. Local conversations created separately on the remote machine and native Codex conversations continue to work as before.

## Commands

```bash
codexhost remote status     # Check whether it is running and installed correctly
codexhost remote start      # Start it (safe to run more than once)
codexhost remote stop       # Stop it without touching other Codex processes
codexhost remote uninstall  # Uninstall it but keep conversation associations
```

After you start, stop, or uninstall, reconnect the SSH workspace in Codex Desktop.

## Upgrade

Upgrade both machines to the same version using the same package manager. Then rerun `codexhost remote install` and `codexhost remote start` on the remote machine and reconnect the SSH workspace.

## Troubleshooting

- **You cannot insert a message into a running native Codex task**: make sure your local codexhost is up to date, then reconnect the SSH workspace and try again.
- **`codexhost/harness/inspect is unsupported on this Host connection`**: the SSH connection isn't going through codexhost. Make sure the same codexhost version is installed and running on the remote machine, then reconnect the SSH workspace.
- **`remote status` says degraded or asks you to reinstall**: run `codexhost remote install`, then `codexhost remote start`.
- **Native Codex requests fail with `Official request failed; retry explicitly`**: reconnect the SSH workspace and try again. If it keeps failing, run `codexhost remote stop` and then `codexhost remote start` on the remote machine, then reconnect.
- **After reconnecting, the workspace briefly connects and then drops**: upgrade both computers to the same latest codexhost version, follow the upgrade steps above to reinstall and start the remote service, then connect the SSH workspace again.
- **The remote machine's GUI does not show SSH conversations**: check that both computers launched Desktop through codexhost, the remote service is running, and the user account and Codex data directory match the requirements above. Wait a few seconds, then check the conversation list again.
- **A Harness is missing**: make sure it is installed and signed in on the remote machine, then click **Run connection diagnostics** in Settings.
- **Install fails on macOS with a launchd / `gui/$UID` error**: the remote Mac needs someone logged in to the desktop. Log in, then run `codexhost remote install` again.
