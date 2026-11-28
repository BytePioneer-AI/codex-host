# Proposal: Background Update Staging & Failure Fallback

## Why

Currently, codexhost only downloads an installer or prefetches npm packages after a user clicks **Update**. Users wait through tens of megabytes of download progress before restart, cannot reuse already downloaded artifacts, receive no confirmation when running Agent tasks will be interrupted, and have no periodic background update preparation.

## What Changes

- Decouple background update staging (`staged`) from the Launcher-watched `prepared` handoff phase so background downloads and verification never trigger service shutdown.
- Add periodic, non-blocking background update checks and silent artifact/npm staging in Host for packaged installations (keeping only the latest staged target version and cleaning obsolete staged files on startup/check).
- Reuse verified staged artifacts (or prefetched npm cache) when the user starts an update so clicking **Restart to update** transitions directly into installation and restart; automatically fall back to live download if the staged copy is missing or invalid.
- Preserve update discoverability when silent staging fails: still notify the user that a newer version is available, clearly report the background download failure inside the Updates settings view, and surface both a **Retry** action and the existing manual update commands and Release link.
- Expose active running task count in update check responses and prompt for confirmation before restarting when one or more sessions are running.
- Display npm download progress in the shared Updates settings view when an interactive npm update downloads live.

## Decisions

1. **Zero Rust updater/launcher protocol changes**: Staging lives in a dedicated `staged/` directory with its own lock (`staging-v1.lock`), completely isolated from `active-update-v1.lock`, `request-v1.json`, and `status-v1.json`. Rust Launcher's 100ms `prepared` poll continues to fire only after explicit user confirmation.
2. **Silent staging failures never hide a new version and never pollute `status-v1.json`**: Background check/staging failures are exposed as separate optional background-staging state on update check responses, while the entry badge still alerts the user that a newer version exists so they can retry or install manually.
3. **Forward-compatible contract extension**: New fields on `UpdateCheckResult` (`stagedVersion`, `backgroundPhase`, `backgroundDownload`, `backgroundError`, `runningTaskCount`) are optional, omitted when idle/empty, and `updateCheckResultSchema` uses `z.object` so new clients stay compatible with older Hosts as well as future optional fields (older pre-staging clients with strict schemas still match same-version Host packaging when active staging fields or running task counts are emitted).
4. **Deferred to a later phase**: Desktop Shell system-tray dynamic labels, real-time WebSocket push events for background staging completion, update-on-quit, and an auto-download preference toggle are out of scope for this change.
