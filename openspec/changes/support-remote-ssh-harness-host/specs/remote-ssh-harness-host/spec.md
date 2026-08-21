## ADDED Requirements

### Requirement: Remote Host SHALL use Codex's native SSH control transport

On macOS and Linux, codexhost SHALL recognize a Codex `app-server --listen unix://` invocation, own the resolved Unix control socket, accept Codex WebSocket connections, and create one Host session per connection. The native Shim SHALL forward `app-server proxy` and other app-server management commands to stock Codex without entering Host Runtime.

#### Scenario: Desktop connects through the stock proxy

- **WHEN** Codex Desktop starts a remote app-server listener and then runs `codex app-server proxy`
- **THEN** the proxy transports the Desktop WebSocket handshake and protocol frames to the codexhost-owned Unix socket
- **AND** the resulting Host session can inspect and start a Harness installed on that SSH host
- **AND** the proxy invocation does not recursively start another Host Runtime

#### Scenario: Remote socket is protected

- **WHEN** the remote Host creates its control socket
- **THEN** the parent directory is private and the socket mode is `0600`
- **AND** binary WebSocket messages are rejected
- **AND** an active socket or non-socket path is not overwritten

### Requirement: Remote Harness execution SHALL remain local to the SSH host

The Host SHALL start the selected Harness with the remote cwd, remote command, and remote account environment. The managed remote installation MUST NOT copy Harness credentials, Codex authentication, or project files to the client. Protocol projections required by the Codex Desktop UI MAY cross the existing SSH channel.

#### Scenario: Claude Code account exists only on the development host

- **GIVEN** Claude Code is authenticated on the SSH host and not on the client
- **WHEN** the client starts and continues a Claude Code Thread in a remote workspace
- **THEN** the Claude process and Native Session run on the SSH host
- **AND** consecutive Turns use the same mapped Native Session
- **AND** no Claude credential file is installed on the client

### Requirement: Remote installation SHALL be isolated and reversible

`codexhost remote install` SHALL create a managed wrapper in a dedicated `CODEX_INSTALL_DIR`, add one bounded export block to the appropriate non-interactive shell startup file, back up that file before changing it, and preserve the existing Codex entrypoint. It SHALL refuse unmanaged wrapper conflicts. `status` SHALL report missing or modified managed resources. `uninstall` SHALL remove only the managed wrapper, manifest, and profile block while preserving backups and remote Host data.

#### Scenario: OpenCodex already owns the normal Codex command

- **GIVEN** the remote user's normal `codex` entrypoint is an OpenCodex or another managed wrapper
- **WHEN** remote installation is supplied the absolute official stock Codex executable
- **THEN** Codex Desktop's future SSH commands use the independent codexhost wrapper through `CODEX_INSTALL_DIR`
- **AND** the normal Codex/OpenCodex entrypoint and configuration remain unchanged

#### Scenario: zsh receives non-interactive SSH commands

- **WHEN** the remote login shell is zsh and no profile override is provided
- **THEN** installation writes its bounded `CODEX_INSTALL_DIR` block to `.zshenv`
- **AND** reconnecting the remote workspace resolves the managed wrapper

### Requirement: Concurrent local and remote Hosts SHALL not share mutable ownership

The remote wrapper SHALL use a dedicated Mapping Store data directory and SHALL not initialize Launcher-owned update state without a Launcher runtime contract.

#### Scenario: A local codexhost instance is already running on the development host

- **WHEN** Codex Desktop also opens a remote SSH Host on that machine
- **THEN** both Host processes acquire separate Mapping Store locks
- **AND** the remote Host remains available
- **AND** remote application update requests report unavailable rather than terminating the Host

#### Scenario: Desktop holds multiple remote proxy connections

- **WHEN** two WebSocket connections are active against one remote Host listener
- **THEN** both sessions use the listener-owned Mapping Store without a lock conflict
- **AND** closing one session does not close persistence for the other session

### Requirement: Renderer Harness routing SHALL follow the active Codex host

Renderer draft routing SHALL accept any active non-empty Codex host ID, bind the selected carrier to that host's request manager, and reconcile the policy whenever the active composer changes hosts. It MUST NOT reuse a policy owned by another host.

#### Scenario: User switches from local to remote workspace

- **WHEN** the active composer changes from the local host to an SSH host
- **THEN** codexhost installs the draft policy on the SSH host's active request manager
- **AND** the selected Harness carrier is applied to the remote `thread/start`
- **AND** the former local policy is not treated as ownership of the remote composer
