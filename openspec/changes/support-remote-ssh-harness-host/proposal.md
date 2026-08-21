## Why

Codex Desktop can open a workspace on another machine through its native SSH connection, but codexhost currently enhances only the local app-server connection. Installing Claude Code and its account on the development host therefore does not make Claude Code available in the Codex Desktop window on the client machine.

## What Changes

- Add a remote Host mode that owns Codex's Unix app-server control socket on a macOS or Linux SSH host and serves the same Host protocol over WebSocket connections.
- Keep `codex app-server proxy` as a transparent byte tunnel so the existing Codex Desktop SSH transport reaches the remote codexhost process without a new network service or credential protocol.
- Add `codexhost remote install`, `status`, and `uninstall` commands that manage an independent `CODEX_INSTALL_DIR` entrypoint without replacing the user's existing `codex` command.
- Make Renderer draft routing follow the active Codex Desktop host ID and the current composer's scoped identity, allowing a genuinely new local or remote task to select a Harness even when the surrounding page has prewarmed another conversation.
- Isolate remote Mapping Store data from a concurrently running local codexhost instance on the same development host.
- Keep Claude Code credentials, native sessions, commands, and working directories on the SSH host.

## Capabilities

### New Capabilities

- `remote-ssh-harness-host`: Managed installation, secure Unix WebSocket transport, host-aware Renderer routing, and remote-local Harness execution for Codex Desktop SSH sessions.

### Modified Capabilities

- `versioned-renderer-agent-routing`: Draft routing policy follows the currently active non-empty host ID instead of accepting only the local host.

## Impact

- Adds a reviewed WebSocket server dependency to the Host Runtime release closure.
- Extends the native Shim's app-server classification so control-socket server invocations enter Host Runtime while proxy/management subcommands stay transparent. In the managed remote environment, only the default Unix listener detaches after its newly created socket is connectable, allowing Codex Desktop's SSH bootstrap to finish without changing foreground command semantics elsewhere.
- Adds a reversible shell startup-file environment block and managed native entrypoint under `~/.codexhost/remote` on an explicitly configured SSH host. The manifest records the installed entrypoint digest so uninstall remains verifiable after an older packaged runtime is removed.
- Does not modify Codex Desktop, the existing remote `codex` entrypoint, OpenCodex configuration, Claude credentials, or project files.
