## Why

Remote SSH Host installation can be valid while its control socket is still owned by a previously started stock Codex App Server. Users on headless hosts currently need to diagnose and terminate that process manually, and `remote status` reports only installation integrity rather than whether the codexhost protocol is actually serving.

## What Changes

- Add `codexhost remote start` to safely replace a conflicting installed stock Codex listener and start the managed codexhost Remote Host.
- Add `codexhost remote stop` to stop only a verified managed Remote Host listener.
- Extend `codexhost remote status` with runtime, socket, and conflict information while preserving installation diagnostics.
- Keep lifecycle commands fail-closed for unknown socket owners or unverifiable process identities.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote-ssh-harness-host`: Add explicit, safe lifecycle management and runtime diagnostics for an installed SSH Host.

## Impact

- `packages/host-runtime`: remote CLI parsing, lifecycle/process inspection, socket probing, and focused tests.
- Release help and packaged CLI documentation.
- Unix-only runtime behavior on macOS and Linux; Windows reports lifecycle commands as unsupported.
