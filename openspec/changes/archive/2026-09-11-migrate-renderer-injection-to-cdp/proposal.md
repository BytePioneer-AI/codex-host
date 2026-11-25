## Why

Codex Desktop 26.901.20858 disables Electron/Node CLI Inspector arguments through an Electron fuse, so codexhost can no longer reach `webContents` to install its Renderer Extension. Chromium Renderer CDP remains available and supports the required page evaluation and new-document injection primitives, so production control must move to that surviving boundary.

## What Changes

- Launch managed Codex Desktop with a random loopback Chromium remote-debugging port instead of a Node Inspector port.
- Connect Desktop Control directly to the primary `app://-/index.html` page target, inject the existing production Renderer bundle into both the current document and future document loads, and recover across reloads or target replacement.
- Move draft prewarm/request-manager policy installation from Electron `webContents.debugger` access to direct Renderer CDP evaluation.
- Make the Electron main-process title policy an optional unavailable capability rather than a prerequisite for all external Agent routing.
- Keep managed startup non-blocking, but retain and expose truthful internal Renderer installation state instead of treating a failed first installation as an installed Session.
- Preserve the existing production Renderer Extension, Host routing contracts, authenticated attachment flow, and official Codex fallback.

## Capabilities

### New Capabilities
- `renderer-cdp-control`: Direct, loopback-only Renderer target discovery, production bundle injection, document lifecycle recovery, and bounded failure behavior.

### Modified Capabilities
- `running-desktop-attachment`: Clean managed launch uses temporary Chromium Renderer CDP rather than Electron Node Inspector.
- `nonblocking-managed-desktop-readiness`: Background recovery is driven by direct Renderer CDP Session installation and must not claim an unavailable Session is installed.
- `versioned-renderer-agent-routing`: Main-process title isolation is no longer a hard prerequisite for safe Renderer Agent routing; external routing remains fail-closed on Renderer-owned prerequisites.

## Impact

- Native launcher attachment arguments and port naming in `crates/launcher`.
- CDP transport, target discovery, Renderer Session lifecycle, production Controller, and draft prewarm policy in `packages/desktop-control`.
- Versioned Renderer Adapter prerequisite checks in `packages/renderer-extension`.
- Focused Rust and TypeScript tests for launch arguments, target selection, injection/reload recovery, installation failure, and title-policy degradation.
- No new runtime dependency and no change to browser-safe shared contracts or Harness Adapter ownership.
