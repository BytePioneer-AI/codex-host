## Why

codexhost must coordinate repeated launches without starting duplicate Desktop or sidecar processes. It should recover stale ownership, launch a new controlled Desktop when none exists, reuse an existing codexhost-controlled Desktop, and explicitly ask users to fully quit an independently started official Desktop before retrying.

## What Changes

- Add per-user launcher ownership and stale-launcher recovery so a launcher with no live Desktop or control endpoint is cleaned up and retried.
- Preserve the current clean-launch path when no Codex Desktop process exists.
- Reuse an existing codexhost-controlled Desktop through one nonce-authenticated Controller activation handshake without starting duplicate runtime processes.
- When an independently started official Desktop is running, return an explicit instruction to fully quit it before starting codexhost; do not inject, restart, or terminate it.
- Remove the unsupported Windows second-activation Inspector/CDP bootstrap and its production-only platform surface while retaining the recorded capability evidence.
- Add focused process-state tests and real Windows user-behavior evidence for clean launch, controlled reuse, official-instance preservation, stale recovery, and cleanup.

## Capabilities

### New Capabilities
- `running-desktop-attachment`: Production launcher state detection, stale ownership recovery, clean launch, controlled-instance reuse, and explicit preservation of an independently started official Desktop.

### Modified Capabilities

## Impact

- Affected Rust crates: `launcher` and `platform` for instance ownership, process identity, clean launch, and controlled-instance orchestration.
- Affected TypeScript package: `desktop-control` for attaching to a discovered local Inspector and proving Renderer plus Host readiness.
- Affected runtime boundary: clean-launch Shim/Host startup and Controller activation for a live codexhost-owned instance.
- Affected tests and Gates: launcher unit/integration tests and an explicit Windows real-Desktop attachment Gate.
- The prior production behavior in `crates/launcher/src/main.rs` and predecessor designs that reject every running Desktop is intentionally superseded for this launch path.
