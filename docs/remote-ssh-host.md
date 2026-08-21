# Remote SSH Harness Host

Codex Desktop can open a project on another machine through its native SSH workflow. Installing codexhost on both machines lets that remote workspace use Harnesses that are installed and authenticated only on the development host, including Claude Code.

This path keeps the native Codex Desktop UI and SSH transport. It does not turn a Claude login into an OpenAI-compatible API: Claude Code itself owns the Native Session on the remote machine.

## Prerequisites

- Codex Desktop and codexhost on the client machine.
- Codex CLI and the same codexhost version on a macOS or Linux SSH host.
- The desired Harness installed and authenticated on the SSH host. For Claude Code, run its normal login there; do not copy its account files to the client.
- A working Codex Desktop SSH workspace before enabling codexhost.

Windows is supported as the client. A Windows machine is not currently supported as the remote Host because Codex's remote control transport uses Unix sockets.

## Install on the SSH host

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote status
```

If `codex` already resolves to OpenCodex or another wrapper, pass the real official Codex executable explicitly:

```bash
codexhost remote install \
  --stock-codex /absolute/path/to/official/codex \
  --claude-command /absolute/path/to/claude
```

The command:

- creates `~/.codexhost/remote/bin/codex`;
- stores remote Mapping Store data separately under `~/.codexhost/remote/data`;
- adds one marked `CODEX_INSTALL_DIR` block to `.zshenv`, `.bashrc`, or the explicitly selected profile;
- writes a timestamped profile backup before changing it;
- leaves the existing `codex` command and OpenCodex configuration untouched.

Reconnect the remote workspace after installation. A currently running remote app-server is not replaced in place.

## Use from Codex Desktop

Start the client-side Codex Desktop through codexhost, open the SSH workspace, and use the Agent/Model selector in that remote composer. Harness discovery, model selection, Threads, Turns, tools, approvals, and history then use the codexhost process on the SSH host.

The remote Claude Code process sees the remote cwd and account. Prompts, streamed output, tool status, approvals, and diffs are projected through the existing SSH channel so Codex Desktop can render them; credential files are not forwarded.

## Diagnose and roll back

```bash
codexhost remote status
codexhost remote uninstall
```

`status` reports a missing or modified wrapper, startup block, runtime, or data directory. `uninstall` removes only the managed wrapper, manifest, and startup block. It preserves profile backups and `~/.codexhost/remote/data` so Thread mappings remain recoverable. Reconnect the remote workspace after uninstalling.

Remote Host processes do not own the local codexhost Launcher or self-update controller. Update codexhost with the same package manager on both machines, then reconnect.
