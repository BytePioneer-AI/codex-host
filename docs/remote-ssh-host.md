# Remote SSH Harness Host

Codex Desktop can open a project on another machine through its native SSH workflow. Installing codexhost on both machines lets that remote workspace use Harnesses that are installed and authenticated only on the development host, including Claude Code and Grok.

This path keeps the native Codex Desktop UI and SSH transport. It does not turn a Claude or Grok login into an OpenAI-compatible API: the selected Harness itself owns the Native Session on the remote machine.

## Prerequisites

- Codex Desktop and codexhost on the client machine.
- Codex CLI and the same codexhost version on a macOS or x64/ARM64 Linux SSH host.
- The desired Harness installed and authenticated on the SSH host. For Claude Code or Grok, run its normal login there; do not copy its account files to the client.
- A working Codex Desktop SSH workspace before enabling codexhost.

Windows is supported as the client. A Windows machine is not currently supported as the remote Host because Codex's remote control transport uses Unix sockets.

## Install on the SSH host

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

If `codex` already resolves to OpenCodex or another wrapper, pass the real official Codex executable explicitly:

```bash
codexhost remote install \
  --stock-codex /absolute/path/to/official/codex \
  --claude-command /absolute/path/to/claude \
  --grok-command /absolute/path/to/grok
```

The command:

- installs the packaged native Shim as `~/.codexhost/remote/bin/codex`. If that binary cannot load because the Linux glibc is older than the packaged native baseline, installation writes a Node entrypoint with the same detach semantics and uses the Node that ran `codexhost`. In the managed remote environment, the exact default `app-server --listen unix://` invocation starts a detached listener, waits until a freshly created control socket accepts connections, and then lets Codex Desktop's background SSH bootstrap return. Local interactive `codex` is unchanged because the managed `CODEX_INSTALL_DIR` is SSH-scoped;
- stores remote Mapping Store data separately under `~/.codexhost/remote/data`;
- adds one marked environment block to `.zshenv`, `.bashrc`, or the explicitly selected profile. The block activates only for an SSH session, so local shells and a local codexhost Desktop on the same machine do not inherit remote Host ownership. In `.bashrc`, the guarded block is placed before the standard non-interactive early-return guard used by Linux distributions such as Ubuntu. It selects `CODEX_INSTALL_DIR` and supplies the absolute stock Codex, Node, Host Runtime, data, and optional Claude Code and Grok paths used by the native entrypoint;
- writes a timestamped profile backup before changing it;
- records the installed native entrypoint digest so a later uninstall can still verify it after an older package runtime has been removed;
- leaves the existing `codex` command and OpenCodex configuration untouched.

The managed listener preserves Codex's native multi-client topology. One long-lived stock `app-server --listen unix://PATH` process owns a private sibling socket for the lifetime of the remote Host listener. Each Desktop SSH proxy connection still gets an isolated codexhost Host session, but that session opens its own WebSocket connection to the same stock app-server listener. Consequently, the stock app-server—not codexhost—owns the loaded Thread, per-connection subscriptions, and native writer/observer coordination. A second Desktop can resume and observe a Thread already loaded by the first connection instead of starting a competing app-server process that fails with `thread ... already has an active writer`. Closing one Desktop connection closes only its Host session; it does not stop the shared stock listener or the other subscribers.

This composition follows the official [Codex app-server transport](https://learn.chatgpt.com/docs/app-server): Unix listeners use WebSockets over the Unix socket, each transport connection initializes independently, and `thread/start`/`thread/resume` manage that connection's Thread subscription. The internal sibling socket is created inside the same private control directory and is never exposed over the network.

When a remote Host starts a Harness, it resolves the development host's proxy environment again: existing `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and related variables take precedence; macOS also supplies missing values from its static system proxy configuration; Linux preserves its environment-variable and TUN-based network paths. codexhost does not identify a specific proxy application or guess proxy ports. If no proxy can be resolved, it proceeds as a direct connection.

Running `remote install` over an earlier preview that used a shell wrapper migrates that entrypoint in place. `remote start` then starts the headless Host without requiring the shell profile to be reloaded. If the target socket is occupied by the current user's installed stock Codex default listener, it terminates that specific listener tree before starting codexhost; unknown socket owners are never terminated automatically.

Detachment is deliberately narrow. The command must contain exactly one default `--listen unix://` and no `--stdio`; duplicate listeners, `app-server proxy`, stdio, explicit custom socket paths, and ordinary Codex commands retain their normal foreground lifecycle. If the default listener exits or does not make its socket ready within ten seconds, the bootstrap fails instead of reporting a false success.

Socket initialization remains serialized across an in-place upgrade. The current listener uses per-owner registers and also publishes a live compatibility marker understood by an already-loaded earlier managed Shim before it unlinks or binds the control socket. An abandoned legacy marker is retained as a passive fence instead of being deleted through its shared pathname.

## Use from Codex Desktop

Start the client-side Codex Desktop through codexhost, open the SSH workspace, and use the Agent/Model selector in that remote composer. Harness discovery, model selection, Threads, Turns, tools, approvals, and history then use the codexhost process on the SSH host. Multiple Desktop clients may attach to the same running native Codex Thread through the shared stock app-server; native subscription and writer/observer behavior remains authoritative. Local Harness availability remains initialized and cached independently, so an unavailable SSH connection cannot block local controls after switching back to a local Composer.

A newly opened task in a remote project remains a draft and should allow Agent selection. Current Desktop builds are classified from the active Composer's own marker, so a background/prewarmed conversation elsewhere on the project page cannot incorrectly lock the new task. Once the first Turn binds the draft, the resulting Thread identity becomes authoritative.

Remote Claude Code and Grok processes see the remote cwd and account. Prompts, streamed output, tool status, approvals, and diffs are projected through the existing SSH channel so Codex Desktop can render them; credential files are not forwarded. Grok still uses its local stdio ACP adapter on the SSH host. It does not require a separate `grok agent serve` daemon.

## Diagnose and roll back

```bash
codexhost remote start
codexhost remote stop
codexhost remote status
codexhost remote uninstall
```

`start` is idempotent and starts the installed headless Remote Host. `stop` stops only a verified codexhost listener and leaves unrelated Codex processes running. `status` reports runtime state and protocol identity in addition to a missing or modified native entrypoint, startup block, runtime, or data directory. A partially edited or otherwise malformed managed startup block is reported as degraded; install and uninstall still refuse to rewrite it automatically. Status also identifies the legacy blocking shell entrypoint and asks for a reinstall migration. `uninstall` verifies the recorded entrypoint digest before removing only the managed entrypoint, manifest, and startup block. It preserves profile backups and `~/.codexhost/remote/data` so Thread mappings remain recoverable. Reconnect the remote workspace after uninstalling.

Remote Host processes do not own the local codexhost Launcher or self-update controller. Update codexhost with the same package manager on both machines, then reconnect.
