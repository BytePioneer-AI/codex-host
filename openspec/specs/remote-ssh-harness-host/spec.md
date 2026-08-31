# remote-ssh-harness-host Specification

## Purpose

Define secure, isolated, and reversible execution of registered Harnesses through Codex Desktop's native SSH control transport.

## Requirements

### Requirement: Remote Host SHALL use Codex's native SSH control transport

On macOS and Linux, codexhost SHALL recognize a Codex `app-server --listen unix://` invocation, own the resolved Unix control socket, accept Codex WebSocket connections, and create one Host session per connection. One long-lived stock Codex app-server listener SHALL serve all of those Host sessions through a private sibling Unix socket, with one independent WebSocket connection per Host session. The native Shim SHALL forward `app-server proxy` and other app-server management commands to stock Codex without entering Host Runtime.

#### Scenario: Desktop connects through the stock proxy

- **WHEN** Codex Desktop starts a remote app-server listener and then runs `codex app-server proxy`
- **THEN** the proxy transports the Desktop WebSocket handshake and protocol frames to the codexhost-owned Unix socket
- **AND** the resulting Host session can inspect and start a Harness installed on that SSH host
- **AND** the proxy invocation does not recursively start another Host Runtime

#### Scenario: Remote socket is protected

- **WHEN** the remote Host creates its control socket
- **THEN** the parent directory is private and the socket mode is `0600`
- **AND** binary WebSocket messages are rejected
- **AND** concurrent startup and shutdown operations serialize socket ownership, including recovery from an abandoned initializer and a late initializer from an already-loaded previous managed Shim during an in-place upgrade
- **AND** an active socket or non-socket path is not overwritten

#### Scenario: Two Desktop clients resume one loaded native Thread

- **GIVEN** one Desktop connection has started or resumed a persisted native Codex Thread
- **WHEN** a second Desktop connection resumes the same Thread through the same remote Host listener
- **THEN** both Host sessions connect to the same stock app-server listener through separate WebSocket connections
- **AND** the stock app-server attaches the second connection to its loaded Thread and native subscription state
- **AND** codexhost does not start a competing stdio app-server or surface an `active writer` error caused by a second process
- **AND** closing either Desktop connection does not stop the shared stock listener or the remaining connection

### Requirement: Remote Harness execution SHALL remain local to the SSH host

The Host SHALL start the selected Harness with the remote cwd, remote command, and remote account environment. The managed remote installation MUST NOT copy Harness credentials, Codex authentication, or project files to the client. Protocol projections required by the Codex Desktop UI MAY cross the existing SSH channel.

#### Scenario: Claude Code account exists only on the development host

- **GIVEN** Claude Code is authenticated on the SSH host and not on the client
- **WHEN** the client starts and continues a Claude Code Thread in a remote workspace
- **THEN** the Claude process and Native Session run on the SSH host
- **AND** consecutive Turns use the same mapped Native Session
- **AND** no Claude credential file is installed on the client

#### Scenario: Grok is installed only on the development host

- **GIVEN** Grok CLI is authenticated on the SSH host and not on the client
- **WHEN** remote installation discovers Grok or is supplied `--grok-command`
- **THEN** the managed profile and listener environment export `CODEXHOST_GROK_COMMAND`
- **AND** the client can inspect Grok and start a Grok Thread in a remote workspace
- **AND** the Grok process uses stdio ACP on the SSH host rather than `grok agent serve`
- **AND** no Grok credential file is installed on the client

### Requirement: Remote installation SHALL be isolated and reversible

`codexhost remote install` SHALL create a managed native Shim entrypoint in a dedicated `CODEX_INSTALL_DIR`, record the installed entrypoint's SHA-256 digest, add one bounded SSH-scoped environment export block to the appropriate non-interactive shell startup file, back up that file before changing it, and preserve the existing Codex entrypoint. If the packaged native Shim cannot load on that Linux host because glibc is older than the native baseline, installation SHALL write a Node entrypoint instead, using the Node that ran `codexhost`, with the same detach and foreground routing rules. It SHALL refuse unmanaged entrypoint conflicts and SHALL migrate its legacy managed shell wrapper in place. In that managed environment, only an invocation containing exactly one default `app-server --listen unix://` listener and no stdio mode SHALL detach from the SSH bootstrap after a newly created expected socket accepts a connection; proxy, stdio, duplicate-listener, custom-listener, and ordinary Codex invocations SHALL retain their foreground lifecycle. `status` SHALL report missing, modified, malformed, or legacy managed resources as degraded. Install and uninstall SHALL remain fail-closed for a malformed managed profile block. `uninstall` SHALL remove only an integrity-verified managed entrypoint, manifest, and profile block while preserving backups and remote Host data.

#### Scenario: OpenCodex already owns the normal Codex command

- **GIVEN** the remote user's normal `codex` entrypoint is an OpenCodex or another managed wrapper
- **WHEN** remote installation is supplied the absolute official stock Codex executable
- **THEN** Codex Desktop's future SSH commands use the independent native codexhost entrypoint through `CODEX_INSTALL_DIR`
- **AND** the normal Codex/OpenCodex entrypoint and configuration remain unchanged

#### Scenario: Desktop backgrounds the remote listener

- **WHEN** Codex Desktop starts the managed `app-server --listen unix://` entrypoint with `nohup ... &`
- **THEN** the managed entrypoint starts the listener in a new Unix session and waits for a newly created expected control socket to accept a connection
- **AND** the SSH bootstrap command returns successfully without waiting for the listener lifetime
- **AND** the native listener process remains alive and owns the expected Unix control socket

#### Scenario: Older glibc cannot load the packaged native Shim

- **GIVEN** the SSH host has a glibc older than the packaged native Shim baseline
- **AND** Node and the packaged Host Runtime are available on that host
- **WHEN** remote installation probes the packaged Shim and the dynamic loader reports a missing GLIBC symbol
- **THEN** installation writes a Node entrypoint at the managed Codex path instead of leaving the unloadable native binary
- **AND** that Node entrypoint still detaches only the default `app-server --listen unix://` listener
- **AND** `app-server proxy` and ordinary Codex commands still exec the stock Codex entrypoint
- **AND** a local interactive `codex` session on the same machine does not inherit remote Host ownership

#### Scenario: Non-listener commands retain foreground ownership

- **WHEN** the managed entrypoint receives `app-server proxy`, `app-server --stdio`, an explicit custom listener path, or an ordinary Codex command
- **THEN** it does not apply the remote listener detachment path
- **AND** command exit, byte streaming, and signal supervision retain their normal lifecycle

#### Scenario: Listener arguments are mixed or duplicated

- **WHEN** the managed entrypoint receives `--stdio` together with a listener, more than one listener argument, or any custom listener value
- **THEN** it does not apply the remote listener detachment path
- **AND** the invocation retains foreground ownership instead of detaching an ambiguous command

#### Scenario: Packaged source runtime is rotated after installation

- **GIVEN** the installed native entrypoint still matches the SHA-256 digest recorded at installation
- **WHEN** the older packaged source Shim no longer exists and the user runs uninstall
- **THEN** uninstall verifies and removes the managed entrypoint without requiring the missing source file
- **AND** a digest mismatch is reported as modification and is never removed automatically

#### Scenario: zsh receives non-interactive SSH commands

- **WHEN** the remote login shell is zsh and no profile override is provided
- **THEN** installation writes its bounded `CODEX_INSTALL_DIR` and runtime environment block to `.zshenv`
- **AND** the block exports remote Host ownership only when the shell has an SSH connection identity
- **AND** reconnecting the remote workspace resolves the managed native entrypoint

#### Scenario: Local shell runs on the same SSH host

- **GIVEN** the machine also runs a local codexhost Desktop or development checkout
- **WHEN** a local shell reads the managed profile without an SSH connection identity
- **THEN** the managed block does not export `CODEX_INSTALL_DIR` or any `CODEXHOST_*` remote Host ownership
- **AND** the local Launcher and Host Runtime retain their own paths, data, and update ownership

#### Scenario: bash profile returns before interactive setup

- **GIVEN** the remote login shell is bash and `.bashrc` contains a standard non-interactive early-return guard
- **WHEN** remote installation writes its bounded environment block
- **THEN** the managed exports appear before that guard and are applied to non-interactive SSH commands
- **AND** reinstall remains idempotent while uninstall restores the original profile contents

### Requirement: Concurrent local and remote Hosts SHALL not share mutable ownership

The remote native entrypoint SHALL use a dedicated Mapping Store data directory and SHALL not initialize Launcher-owned update state without a Launcher runtime contract.

#### Scenario: A local codexhost instance is already running on the development host

- **WHEN** Codex Desktop also opens a remote SSH Host on that machine
- **THEN** both Host processes acquire separate Mapping Store locks
- **AND** the remote Host remains available
- **AND** remote application update requests report unavailable rather than terminating the Host

#### Scenario: Desktop holds multiple remote proxy connections

- **WHEN** two WebSocket connections are active against one remote Host listener
- **THEN** both sessions use the listener-owned Mapping Store without a lock conflict
- **AND** both sessions use independent WebSocket connections to one listener-owned stock app-server process
- **AND** closing one session does not close persistence for the other session

### Requirement: Renderer Harness routing SHALL follow the active Codex host

Renderer draft routing SHALL accept any active non-empty Codex host ID, bind the selected carrier to that host's request manager, and reconcile the policy whenever the active composer changes hosts. On a supported current Desktop build, it SHALL classify draft versus bound Thread identity from the current Composer's scoped marker rather than unrelated page ancestors. It MUST NOT reuse a policy owned by another host.

#### Scenario: User switches from local to remote workspace

- **WHEN** the active composer changes from the local host to an SSH host
- **THEN** codexhost installs the draft policy on the SSH host's active request manager
- **AND** the selected Harness carrier is applied to the remote `thread/start`
- **AND** the former local policy is not treated as ownership of the remote composer

#### Scenario: New remote task shares a page with a prewarmed conversation

- **GIVEN** a remote project page contains a background or prewarmed conversation ID outside the active Composer
- **WHEN** the user opens a new unsubmitted task whose scoped Composer marker has no conversation ID
- **THEN** the Adapter keeps the task in draft routing and allows Harness selection
- **AND** after submission, the scoped bound Thread ID takes precedence even if draft settings remain cached
