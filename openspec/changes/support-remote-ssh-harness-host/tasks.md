## 1. Remote Transport

- [x] 1.1 Classify app-server server and proxy/management invocations at the native Shim boundary.
- [x] 1.2 Add a secure Unix WebSocket listener with one Host session per connection and stock stdio app-server children.
- [x] 1.3 Add focused transport, stale-socket, permission, release-closure, and executable-bundle tests.

## 2. Managed Remote Installation

- [x] 2.1 Add idempotent `remote install`, `status`, and `uninstall` commands with managed profile blocks and backups.
- [x] 2.2 Preserve the existing Codex/OpenCodex entrypoint and provide absolute stock Codex and Claude Code overrides.
- [x] 2.3 Isolate remote Mapping Store data and disable Launcher-owned updates for direct remote Host invocations.
- [x] 2.4 Detach only the managed default Unix listener after socket readiness while preserving foreground proxy and command semantics.
- [x] 2.5 Record installed entrypoint integrity so uninstall remains verifiable across packaged-runtime rotation.

## 3. Renderer Routing

- [x] 3.1 Bind draft-prewarm routing policy to any active non-empty Host ID.
- [x] 3.2 Reconcile and re-apply the selected carrier when Codex Desktop switches between local and remote composers.
- [x] 3.3 Add focused remote-host policy and adapter tests.
- [x] 3.4 Scope current-build Composer identity to its direct portal marker so a new remote task is not locked by ancestor prewarm state.

## 4. Documentation and Validation

- [x] 4.1 Document installation, OpenCodex coexistence, security boundaries, status checks, reconnect, and rollback in English and Chinese.
- [x] 4.2 Add a real remote Gate that traverses WebSocket, `app-server proxy`, Unix socket, Host Runtime, and two context-dependent Claude Code Turns.
- [x] 4.3 Run targeted build, test, lint, format, boundary, Rust, release-package, and strict OpenSpec checks.
- [ ] 4.4 Install the branch artifacts on both machines and validate selection, streaming, context continuity, cancellation, and resume in a real Codex Desktop SSH workspace.
