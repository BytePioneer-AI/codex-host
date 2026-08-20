## Why

codexhost already has distribution-specific background installation, verification, rollback, and relaunch primitives, but users cannot discover a GitHub Release or invoke that machinery from the installed Renderer. The remaining product path must connect those primitives without exposing arbitrary network, filesystem, package-manager, or process-control capabilities to the browser bundle.

## What Changes

- Treat the public `BytePioneer-AI/codex-host` GitHub Releases `latest` API response as the stable update catalog; no custom manifest, checksum sidecar, or codexhost server is introduced.
- Resolve the current installation from packaged distribution metadata and select exactly one expected GitHub Release asset by target, using GitHub's declared size and SHA-256 digest.
- Add fixed check, start, and status operations that never accept a Renderer-supplied URL, digest, path, command, or version.
- Compose the existing `@codexhost/update-manager` and native Updater into the production Host/Controller lifecycle, serialize update attempts, and request an orderly managed Desktop and Launcher exit only after the temporary Updater is running.
- Add a browser-safe Updates settings page with current/latest version, bounded GitHub Release body rendered as Markdown, release-notes link, update-and-restart action, bounded progress, failure retry, and post-restart result recovery.
- Persist discoverable local operation status, clean stale completed work, and keep update-check failures non-blocking for normal launch.
- Update the PRD, engineering status, release checks, and focused automated/real-platform verification to match the implemented behavior.

## Capabilities

### New Capabilities
- `github-release-background-update`: Stable GitHub Release discovery, trusted asset selection, installed-distribution resolution, serialized prepare/start, managed shutdown, status recovery, and relaunch behavior.

### Modified Capabilities
- `extensible-settings-shell`: Add a method-specific Updates page and lifecycle-safe update interaction without exposing a generic request or process-control bridge.
- `shared-runtime-contracts`: Add strict browser-safe schemas for the fixed update check, start, and status operations and their bounded results.

## Impact

- Affected packages and crates: `update-manager`, `shared-contracts`, `host-runtime`, `desktop-control`, `renderer-extension`, `launcher`, `updater`, and release tests/workflow.
- Affected product surfaces: installed application settings, managed Desktop shutdown/restart, GitHub Release reads, npm global replacement, Windows Inno upgrade, and macOS DMG replacement.
- No new public service, release metadata file, signing requirement, Harness behavior, transcript persistence, or arbitrary Renderer bridge is introduced.
