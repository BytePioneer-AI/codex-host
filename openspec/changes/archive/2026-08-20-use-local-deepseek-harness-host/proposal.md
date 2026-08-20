## Why

The current DeepSeek Harness fast path starts a codexhost-owned minimal Cordis composition and writes to a private Session root. As a result, it does not use the tools, Skills, presets, permissions, settings, or Session store of the user's configured local DSH installation, and codexhost-created conversations are absent from the official DSH Web surface.

## What Changes

- **BREAKING** Replace the codexhost-owned `dsh-jsonrpc-agent` runtime and private Session root with the public API of the user's local `dsh web` Host.
- Reuse the active local Web profile as the source of truth for plugins, tools, Skills, credentials, settings, model routes, permissions, presets, and Native Session persistence.
- Connect to an already-running compatible loopback DSH Host, or start the configured local DSH Web command on demand when no Host is reachable.
- Create and resume official DSH Native Sessions through `session.create`, `session.history`, `session.prompt`, `session.cancel`, and the Host event stream.
- Keep session visibility one-way: official DSH lists codexhost-created Sessions, while codexhost lists only Native Sessions recorded in its own Thread mapping store and does not import pre-existing DSH Sessions.
- Remove the obsolete codexhost Cordis runtime, JSON-RPC bridge, and DSH-specific private persistence configuration.

## Capabilities

### New Capabilities
- `local-deepseek-harness-session`: Connecting to a configured local DSH Web Host, owning official Native Sessions, projecting live/history events, restoring mapped Sessions, and maintaining one-way visibility.

### Modified Capabilities
- `registered-harness-routing`: DeepSeek Harness availability and routing now depend on a compatible local DSH Web Host that codexhost can connect to or start, rather than a bundled private runtime.

## Impact

- Replaces the transport and lifecycle internals of `packages/adapters/deepseek-harness` while retaining the `HarnessAdapter` boundary and Host/Renderer routing.
- Adds exact-pinned official DSH Host API client dependencies and removes dependencies used only by the private Cordis runtime.
- Adds managed local Host discovery/startup and shared connection ownership to Host Runtime composition.
- Makes official DSH Session persistence and API compatibility external runtime prerequisites; production packaging no longer bundles a parallel DSH runtime closure.
