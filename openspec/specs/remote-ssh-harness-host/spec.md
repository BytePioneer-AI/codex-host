# remote-ssh-harness-host Specification

## Purpose

Define secure, isolated, and reversible execution of registered Harnesses through Codex Desktop's native SSH control transport.

## Requirements

### Requirement: Remote Host SHALL use Codex's native SSH control transport

On macOS and Linux, codexhost SHALL recognize a Codex `app-server --listen unix://` invocation, own the resolved Unix control socket, accept Codex WebSocket connections, and create one Host session per connection. One long-lived stock Codex app-server listener SHALL serve all of those Host sessions through a private sibling Unix socket, with one independent WebSocket connection per Host session. An unexpected Desktop transport disconnect SHALL end that Host session's Desktop input without treating the disconnect as a user cancellation. If an official or external Harness Turn is active, or an official `turn/start` has been forwarded and is awaiting its response, the Host session SHALL retain its owned runtime resources until the work reaches a real terminal event. Explicit listener shutdown SHALL still hard-close every owned Host session. The native Shim SHALL forward `app-server proxy` and other app-server management commands to stock Codex without entering Host Runtime.

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

#### Scenario: Desktop transport drops during an active Turn

- **GIVEN** a remote Host session has an active native Codex or external Harness Turn
- **WHEN** its Desktop WebSocket closes without an explicit `turn/interrupt`
- **THEN** codexhost ends only that session's Desktop input and does not send or synthesize Turn cancellation
- **AND** the owned official connection and Harness Session remain alive until the Turn emits its real terminal event
- **AND** the terminal state is persisted before the disconnected Host session releases its resources

#### Scenario: Desktop transport drops while official Turn start is in flight

- **GIVEN** a remote Host session has forwarded an official `turn/start` request
- **WHEN** its Desktop WebSocket closes before the response or `turn/started` event arrives
- **THEN** codexhost retains the official connection while the start request is pending
- **AND** a successful response keeps the session alive until `turn/completed`
- **AND** a failed response releases the disconnected session without leaking it

#### Scenario: Desktop repeats a matching remote listener bootstrap

- **GIVEN** the installed managed Remote Host already owns a healthy control socket
- **WHEN** Desktop invokes the same default `app-server --listen unix://` bootstrap again
- **AND** Desktop first applies its stock-listener cleanup selector
- **THEN** the managed listener does not advertise the stock `desktop-ssh-websocket-v0.sock` process marker and survives that cleanup
- **AND** the Shim verifies the socket owner against the installed Node and Host Runtime paths
- **AND** it returns success without starting a competing listener or replacing the socket identity
- **AND** a socket owned by a different installed command is rejected instead of reused or overwritten

#### Scenario: Remote listener stops with detached work

- **GIVEN** a Desktop WebSocket has disconnected while its Host session is draining active work
- **WHEN** the remote listener is explicitly stopped
- **THEN** codexhost hard-closes the detached Host session and all of its owned resources
- **AND** listener shutdown does not wait indefinitely for the Turn to finish

### Requirement: Remote Harness execution SHALL remain local to the SSH host

The Host SHALL start the selected Harness with the remote cwd, remote command, and remote account environment. The managed remote installation MUST NOT copy Harness credentials, Codex authentication, or project files to the client. Protocol projections required by the Codex Desktop UI MAY cross the existing SSH channel.

#### Scenario: Claude Code account exists only on the development host

- **GIVEN** Claude Code is authenticated on the SSH host and not on the client
- **WHEN** the client starts and continues a Claude Code Thread in a remote workspace
- **THEN** the Claude process and Native Session run on the SSH host
- **AND** consecutive Turns use the same mapped Native Session
- **AND** no Claude credential file is installed on the client

### Requirement: Remote installation SHALL be isolated and reversible

`codexhost remote install` SHALL create a managed native Shim entrypoint in a dedicated `CODEX_INSTALL_DIR`, record the installed entrypoint's SHA-256 digest, add one bounded SSH-scoped environment export block to the appropriate non-interactive shell startup file, back up that file before changing it, and preserve the existing Codex entrypoint. It SHALL refuse unmanaged entrypoint conflicts and SHALL migrate its legacy managed shell wrapper in place. In that managed environment, only an invocation containing exactly one default `app-server --listen unix://` listener and no stdio mode SHALL detach from the SSH bootstrap after a newly created expected socket accepts a connection; proxy, stdio, duplicate-listener, custom-listener, and ordinary Codex invocations SHALL retain their foreground lifecycle. `status` SHALL report missing, modified, malformed, or legacy managed resources as degraded. Install and uninstall SHALL remain fail-closed for a malformed managed profile block. `uninstall` SHALL remove only an integrity-verified managed entrypoint, manifest, and profile block while preserving backups and remote Host data.

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
