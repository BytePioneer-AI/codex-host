## Why

The startup compatibility gate conflates unauthenticated, loading, reloading, and temporarily unavailable Renderer states with destructive Codex Desktop incompatibility. These four results currently stop the entire managed application even though the official Codex path and Host pass-through can remain usable while Renderer capabilities recover.

## What Changes

- **BREAKING** Remove `title-isolation`, `agent-routing`, `draft-routing`, and `compatibility-detection` as Launcher-blocking readiness results and user-visible compatibility errors.
- Start the managed Launcher, Shim, Host, Desktop, and Controller without waiting for those four Renderer capabilities to become ready.
- Keep the Controller alive and retry Renderer installation after login, reload, webContents replacement, or transient Inspector failure.
- Keep external Agent controls unavailable until their existing local routing, Draft prewarm, and title ownership prerequisites are actually ready; do not report unavailable capabilities as compatible.
- Preserve non-blocking warnings and unrelated local capability degradation behavior without using them to block managed startup.
- Remove compatibility-triggered update checks and the blocking compatibility dialog path for the four removed results; normal Settings-based updates remain unchanged.
- Update product, architecture, and implementation baselines to define managed startup separately from optional Renderer capability readiness.

## Capabilities

### New Capabilities
- `nonblocking-managed-desktop-readiness`: Defines managed startup, background Renderer capability recovery, and behavior while Renderer integration is unavailable.

### Modified Capabilities
- `codex-desktop-compatibility-guidance`: Removes the four blocking compatibility outcomes and limits user guidance to non-blocking reviewed warnings.
- `versioned-renderer-agent-routing`: Replaces startup-wide fail-closed termination with local external-control unavailability until routing, Draft, and title prerequisites are ready.

## Impact

Affected areas include the Rust Launcher compatibility protocol and native prompts, Desktop Controller startup/retry lifecycle, Renderer Control Session readiness modeling, Controller attachment behavior, compatibility-update entry points, focused Rust/Vitest tests, release bundle assertions, the PRD, engineering baseline, development checklist, and compatibility design documentation. The Host routing fallback remains official Codex for requests without an external transport carrier.
