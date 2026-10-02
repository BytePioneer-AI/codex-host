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

`remote install` adds a clearly marked block to your shell profile that only applies to SSH sessions, and backs up the profile first. Your local shells and existing `codex` command are left alone. On macOS, it also installs a per-user LaunchAgent that starts Claude Code in your logged-in session. It never reads the Keychain or any credentials.

## Usage

1. On your local machine, launch Codex Desktop through codexhost.
2. Open the SSH workspace.
3. Pick a Harness from the composer's Agent / Model selector.

A local Desktop launched through codexhost can also connect to a stock Codex remote Host: native conversations do not require remote `codexhost/*` methods; external Harnesses require remote codexhost. Thread ownership, Harness availability, configuration requests, and usage notifications are scoped to each composer's Host. Hidden composers on other Hosts must not block model loading or change its Harness selection. Native Model version requirements depend on the running remote app-server, not merely the CLI version installed on disk.

## Commands

```bash
codexhost remote status     # Check whether it is running and installed correctly
codexhost remote start      # Start it (safe to run more than once)
codexhost remote stop       # Stop it without touching other Codex processes
codexhost remote uninstall  # Uninstall it but keep your Thread mapping data
```

After you start, stop, or uninstall, reconnect the SSH workspace in Codex Desktop.

## Upgrade

Upgrade both machines to the same version using the same package manager. Then rerun `codexhost remote install` and `codexhost remote start` on the remote machine and reconnect the SSH workspace.

## Troubleshooting

- **Inserting a message into a running native Codex task reports unsupported `codexhost/thread/ownership/list`**: the client verifies the native Thread on the same connection and then uses Desktop's native steering. This fallback does not apply to external Harness Threads or connection failures.
- **`codexhost/harness/inspect is unsupported on this Host connection`**: the SSH connection isn't going through codexhost. Make sure the same codexhost version is installed and running on the remote machine, then reconnect the SSH workspace.
- **`remote status` says degraded or asks you to reinstall**: run `codexhost remote install`, then `codexhost remote start`.
- **Native Codex requests fail with `Official request failed; retry explicitly`**: if the official Codex process on the remote machine exits, codexhost restarts it automatically with backoff, and reconnecting the SSH workspace retries immediately. If it keeps failing, run `codexhost remote stop` and then `codexhost remote start`.
- **After reconnecting, the workspace connects for a few seconds, drops, and only the next reconnect works**: when a previous listener left its control socket behind on the remote machine (for example after being force-killed), older versions misjudged the new listener as not ready and terminated it after 10 seconds. Upgrade to a version with the fix. As a workaround, reconnecting once more usually recovers, because the terminated listener removes the socket when it exits normally. If the problem persists, confirm that no listener is running on the remote machine (`pgrep -f '^codexhost remote app-server listener'` prints nothing), then delete `~/.codex/app-server-control/app-server-control.sock` (under `CODEX_HOME` when it is set) and reconnect.
- **A Harness is missing**: make sure it is installed and signed in on the remote machine, then click **Run connection diagnostics** in Settings.
- **Install fails on macOS with a launchd / `gui/$UID` error**: the remote Mac needs someone logged in to the desktop. Log in, then run `codexhost remote install` again.
