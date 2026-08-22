## Context

Codex Desktop's SSH integration starts `codex ... app-server --listen unix://` on the remote host and opens one or more `codex app-server proxy` processes that tunnel raw bytes to the remote Unix control socket. The local codexhost launch path instead hosts one stdio app-server session and attaches its Renderer extension to the local Desktop window.

A remote solution must preserve the native SSH transport, execute Claude Code beside the repository and account on the development host, coexist with an already installed Codex/OpenCodex chain, and avoid exposing a TCP listener or copying credentials to the client.

## Goals / Non-Goals

**Goals:**

- Make registered Harnesses on a macOS or Linux SSH host selectable from the native Codex Desktop remote workspace.
- Preserve Codex's remote control-socket and proxy protocol rather than adding a second SSH or HTTP gateway.
- Keep Harness processes, native sessions, credentials, tools, and cwd on the remote host.
- Provide an idempotent, inspectable, and reversible install path that does not overwrite the existing `codex` command.
- Allow local and remote codexhost instances to run concurrently on the same development host.

**Non-Goals:**

- Forwarding Claude, Pi, Grok, or DeepSeek credentials from the remote host to the client.
- Supporting a Windows machine as the remote Host; Codex's current remote control transport uses Unix sockets.
- Replacing Codex Desktop's SSH discovery, authentication, workspace selection, or raw proxy implementation.
- Making application self-update available inside a directly invoked remote Host process.
- Hiding prompts, streamed output, tool status, or diffs from the client UI; those protocol projections necessarily cross the existing SSH channel.

## Decisions

1. **Own the existing Unix control socket.** A remote Host invocation recognizes `app-server --listen unix://`, creates the expected `${CODEX_HOME}/app-server-control/app-server-control.sock`, and serves HTTP WebSocket upgrades there. Each WebSocket connection receives its own `AppServerHost` and official `app-server --stdio` child. This matches Codex Desktop's connection model without opening a TCP port.

2. **Keep proxy and management commands transparent.** The native Shim enters Host Runtime only for app-server server invocations. `app-server proxy`, daemon, and code-generation subcommands execute the stock Codex binary directly, so the SSH byte tunnel never recursively starts another Host.

3. **Install through an independent native `CODEX_INSTALL_DIR` entrypoint.** `codexhost remote install` atomically copies the packaged native Shim to `~/.codexhost/remote/bin/codex`, records the installed bytes' SHA-256 digest in the managed manifest, and writes a bounded marked export block in the non-interactive shell startup file (`.zshenv` for zsh, `.bashrc` for bash). A shell-script wrapper is intentionally avoided: Codex Desktop waits for its background SSH bootstrap command to return while the remote listener remains alive, and an interpreter wrapper can keep that bootstrap shell open indefinitely. The managed profile marks the native entrypoint as remote. For an invocation containing exactly one default `app-server --listen unix://` listener and no `--stdio`, that entrypoint starts a child in a new Unix session, waits for a newly created expected control socket to accept connections, and then returns the bootstrap parent. The detached child continues the normal supervised Host Runtime path. `app-server proxy`, `--stdio`, duplicate or custom listeners, and all other commands remain foreground processes. Startup exits non-zero if the child dies or readiness is not reached within ten seconds. Codex Desktop already prepends `CODEX_INSTALL_DIR` when starting remote commands. The installer refuses unmanaged path conflicts, preserves the previous profile, and never replaces the user's normal Codex/OpenCodex entrypoint. Status and uninstall compare the installed entrypoint to its recorded digest, so an intact managed file remains safely removable after the source runtime is rotated away; older manifests without a digest keep the source-comparison fail-closed behavior.

4. **Keep stock Codex explicit and Claude local.** The managed profile block exports absolute packaged Node, Host Runtime, stock Codex, data, and optional Claude Code paths for the native entrypoint. The Host starts the stock Codex app-server directly and the Claude Adapter starts the remote Claude Code command. No account artifact is read or transferred by the installer.

5. **Isolate remote persistence and share it inside the listener.** The managed profile block assigns `CODEXHOST_DATA_DIR=~/.codexhost/remote/data`. This prevents the remote SSH Host and a local codexhost Desktop instance on the same machine from contending for one Mapping Store lock. The remote listener initializes one Mapping Store and shares it across concurrent WebSocket Host sessions; individual session shutdown does not release the listener-owned store. Uninstall preserves this data directory for recovery.

6. **Bind Renderer policy to the active host and scoped Composer identity.** The draft-prewarm policy records both its bridge and host ID. A composer switch reconciles the policy even after initial installation and re-applies the selected Harness carrier to the active host's request manager. For current Codex Desktop builds, the Adapter reads the direct `data-above-composer-portal` child: an omitted conversation attribute identifies an unsubmitted draft, while a validated attribute identifies a bound Thread. This prevents a background or prewarmed conversation ID on a remote project page ancestor from locking a new task as an existing Codex Thread. Older reviewed builds retain their fail-closed Fiber fallback. Empty or ambiguous identities remain invalid.

7. **Do not initialize launcher-owned updates remotely.** A directly invoked remote Host has no Launcher identity, controller nonce, or updater ownership. Host composition creates an update coordinator only when the Launcher PID contract is present; remote update requests return the existing unavailable response instead of creating an unhandled rejected promise.

8. **Bound and protect the socket lifecycle.** The parent directory is mode `0700`, the socket is mode `0600`, binary WebSocket frames are rejected, and stale sockets are removed only after type and liveness checks. Concurrent bind and unlink operations use per-owner Bakery registers in an adjacent private directory; abandoned entries are removed only through their unique owner paths, so one recovery process cannot unlink a successor's lock. Before the Bakery winner enters the critical section, it also publishes a live version 1 compatibility marker at the legacy shared path. An already-loaded earlier Shim therefore waits during an in-place upgrade instead of racing the new listener. A validated abandoned legacy marker remains a passive fence and is never deleted through its replaceable shared pathname. An active socket or a non-socket path is never overwritten.

## Risks / Trade-offs

- [Shell startup semantics differ] -> Default to the startup file read by non-interactive SSH commands and allow an explicit `--profile` override.
- [A managed entrypoint may be mistaken for stock Codex] -> Accept `--stock-codex` and document that it must point to the real official Codex executable when another launcher already owns `codex`.
- [Codex Desktop changes its remote socket protocol] -> Keep parsing narrow, test the real `app-server proxy` byte tunnel, and fail without replacing an unknown listener.
- [Two codexhost instances could share state] -> Use a dedicated remote data directory and mode `0700`.
- [Release bundling of the CommonJS WebSocket dependency under ESM] -> Inject a scoped `createRequire` bridge and execute the built bundle in a release smoke test.
- [Installing while a remote session is active] -> Installation affects only subsequent SSH commands; documentation requires reconnecting the remote workspace.
- [A detached listener could make bootstrap report success too early] -> Require a new socket identity, a successful Unix-socket connection, and a still-running child before the parent returns; terminate the child on timeout.
- [A page-level prewarm Thread could be mistaken for the active Composer] -> Prefer the current build's Composer-scoped portal marker and cover both draft and post-bind states with focused Renderer tests.

## Migration Plan

1. Install the same codexhost build on the client and SSH host.
2. Log in to the desired Harness only on the SSH host and run `codexhost remote install`, passing the real stock Codex path when needed.
3. Verify `codexhost remote status`, reconnect the Codex Desktop remote workspace, and select the remote Harness.
4. Roll back with `codexhost remote uninstall`; reconnecting returns Codex Desktop to the prior remote `codex` entrypoint. Profile backups and remote Mapping Store data remain recoverable.
