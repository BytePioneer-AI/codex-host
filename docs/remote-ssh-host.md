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

- installs the packaged native Shim as `~/.codexhost/remote/bin/codex`. In the managed remote environment, the exact default `app-server --listen unix://` invocation starts a detached listener, waits until a freshly created control socket accepts connections, and then lets Codex Desktop's background SSH bootstrap return;
- stores remote Mapping Store data separately under `~/.codexhost/remote/data`;
- adds one marked environment block to `.zshenv`, `.bashrc`, or the explicitly selected profile. The block selects `CODEX_INSTALL_DIR` and supplies the absolute stock Codex, Node, Host Runtime, data, and optional Claude Code paths used by the native entrypoint;
- writes a timestamped profile backup before changing it;
- records the installed native entrypoint digest so a later uninstall can still verify it after an older package runtime has been removed;
- leaves the existing `codex` command and OpenCodex configuration untouched.

Running `remote install` over an earlier preview that used a shell wrapper migrates that entrypoint in place. Reconnect the remote workspace after installation. A currently running remote app-server is not replaced in place.

Detachment is deliberately narrow. The command must contain exactly one default `--listen unix://` and no `--stdio`; duplicate listeners, `app-server proxy`, stdio, explicit custom socket paths, and ordinary Codex commands retain their normal foreground lifecycle. If the default listener exits or does not make its socket ready within ten seconds, the bootstrap fails instead of reporting a false success.

## Use from Codex Desktop

Start the client-side Codex Desktop through codexhost, open the SSH workspace, and use the Agent/Model selector in that remote composer. Harness discovery, model selection, Threads, Turns, tools, approvals, and history then use the codexhost process on the SSH host.

A newly opened task in a remote project remains a draft and should allow Agent selection. Current Desktop builds are classified from the active Composer's own marker, so a background/prewarmed conversation elsewhere on the project page cannot incorrectly lock the new task. Once the first Turn binds the draft, the resulting Thread identity becomes authoritative.

The remote Claude Code process sees the remote cwd and account. Prompts, streamed output, tool status, approvals, and diffs are projected through the existing SSH channel so Codex Desktop can render them; credential files are not forwarded.

## Diagnose and roll back

```bash
codexhost remote status
codexhost remote uninstall
```

`status` reports a missing or modified native entrypoint, startup block, runtime, or data directory. A partially edited or otherwise malformed managed startup block is reported as degraded; install and uninstall still refuse to rewrite it automatically. Status also identifies the legacy blocking shell entrypoint and asks for a reinstall migration. `uninstall` verifies the recorded entrypoint digest before removing only the managed entrypoint, manifest, and startup block. It preserves profile backups and `~/.codexhost/remote/data` so Thread mappings remain recoverable. Reconnect the remote workspace after uninstalling.

Remote Host processes do not own the local codexhost Launcher or self-update controller. Update codexhost with the same package manager on both machines, then reconnect.
