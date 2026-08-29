## Why

The production Desktop Controller no longer emits compatibility warnings or blocking incompatibility outcomes, but the Launcher, platform UI, acknowledgement persistence, and a compatibility-only update bridge still implement those now-unreachable flows. Keeping the dead vertical slice obscures the actual non-blocking recovery policy and has already caused maintainers to incorrectly conclude that Renderer incompatibility still prompts users.

## What Changes

- Remove the unreachable Launcher compatibility-warning decision flow and platform-specific compatibility dialogs.
- Remove compatibility acknowledgement persistence and unsupported readiness variants that the production Controller cannot emit.
- Remove the compatibility-dialog-only update request path from Launcher attachment, Desktop Controller, Renderer Session, and Renderer binding code while retaining the normal Settings update flow.
- Keep the strict initial Controller readiness handshake, runtime Renderer compatibility probes, fail-closed external routing, background recovery, controlled-instance attachment, stock Desktop launch support used elsewhere, and all non-compatibility dialogs.
- Update specifications so Renderer compatibility failures remain silent, non-blocking internal recovery states and Controller readiness represents startup acceptance rather than a user compatibility decision.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `codex-desktop-compatibility-guidance`: Remove the obsolete warning dialog, acknowledgement, and compatibility-specific update behavior; retain silent recovery and sanitized diagnostics requirements.
- `running-desktop-attachment`: Simplify first-readiness handling to a strict compatible-only startup handshake with no warning decision before descriptor publication.
- `nonblocking-managed-desktop-readiness`: Clarify that compatibility-dialog support and its dedicated update command are absent while runtime recovery remains intact.

## Impact

- Rust: `crates/launcher` compatibility/readiness parsing and launch flow; `crates/platform` compatibility-only UI exports and implementations.
- TypeScript: `packages/desktop-control` attachment/session interfaces and `packages/renderer-extension` compatibility-only update bridge.
- Tests: focused Rust and package tests for readiness, attachment, Renderer Session, and update behavior.
- Specifications: compatibility guidance, running Desktop attachment, and non-blocking readiness.
- Normal codexhost update controls in Settings, runtime CDP/Renderer probes, background recovery, and unrelated platform dialogs remain unchanged.
