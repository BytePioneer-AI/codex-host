# Design: Background Update Staging & Failure Fallback

## Storage & Lock Isolation

- Active handoff directory remains `<stateDirectory>/update-<version>-<id>/` guarded by `active-update-v1.lock`.
- Background staging uses `<stateDirectory>/staged/` guarded by a separate `staging-v1.lock`:
  - `<stateDirectory>/staged/staged-v1.json`: atomic metadata record (`schemaVersion: 1`, `version`, `distribution`, `target`, `stagedAt`, plus for installers: `assetName`, `artifactPath`, `sha256`, `size`).
  - `<stateDirectory>/staged/update-<version>/<assetName>`: verified installer artifact.
- Because staging never writes `active-update-v1.lock`, `request-v1.json`, or `status-v1.json`:
  - Rust Launcher's 100ms `active_update` poll never sees a staged artifact as a shutdown trigger.
  - Background download failures never pollute the 24-hour user-facing `status-v1.json` failure banner.
- Disk hygiene: before staging a new version, previous `staged/update-*` subdirectories are removed (retaining at most one target version). When Host starts or runs `check()` and `compareSemanticVersions(currentVersion, staged.version) >= 0`, `staged/` is removed.

## Shared Contract (`packages/shared-contracts/src/updates.ts`)

Extend `updateCheckResultSchema` with optional backward-compatible fields:
- `stagedVersion?: string | null`
- `backgroundPhase?: "idle" | "downloading" | "ready" | "failed"`
- `backgroundDownload?: { downloadedBytes: number; totalBytes: number } | null`
- `backgroundError?: string | null`
- `runningTaskCount?: number`

## Host Coordinator Scheduling (`packages/host-runtime/src/update-coordinator.ts`)

- Enabled only when packaged distribution metadata resolves cleanly (disabled in source checkouts and tests unless started explicitly, with clean `dispose()` timer teardown).
- Schedule: initial check after 45s delay, repeating every 4 hours (+ small jitter). Uses optional `ETag` / `If-None-Match` on GitHub Releases API (304 reuses cached release without consuming anonymous rate limit).
- On discovering a newer version with `installationAvailable === true`:
  - If valid staged metadata already matches `release.version`, report `backgroundPhase: "ready"`, `stagedVersion: release.version`.
  - Otherwise launch a single serialized background staging job (updating in-memory `backgroundPhase` / `backgroundDownload`).
  - On staging failure: record bounded `backgroundError` and `backgroundPhase: "failed"`, retry automatically at most twice for the same version with exponential backoff, and keep `updateAvailable: true` so entry badges and the Updates page still alert the user.
- If user calls `start()` while background staging for the same version is already running, join/reuse that work (or wait briefly) rather than downloading twice.
- `AppServerHost` passes `runningTaskCount: () => this.runningThreadIds().length` into `createHostUpdateCoordinator`.

## UI Surfaces (`packages/renderer-extension` & `apps/web-ui`)

- **Entry badges** (`renderer-extension/src/settings/trigger.ts`, `renderer-settings-lifecycle.ts`, `apps/web-ui/.../SettingsLauncher.tsx`):
  - Light the indicator whenever `updateAvailable` is true (including when `backgroundPhase === "failed"` so users never miss an update).
  - When `stagedVersion === latestVersion && backgroundPhase === "ready"`, show tooltip `"重启以更新到 v<ver>"` / `"Restart to update to v<ver>"`; otherwise show the standard new-version-available tooltip.
  - Refresh update status on a low-frequency interval (e.g. while connected/visible) so long-running sessions pick up completed background staging without manual reloads.
- **Shared Updates settings page** (`packages/renderer-extension/src/settings/pages.ts` & `localization.ts`):
  - Ready state (`stagedVersion === latestVersion`): primary button shows `"重启以更新"` / `"Restart to update"` with concise ready status note.
  - Background download in progress (`backgroundPhase === "downloading"`): display current background download progress; clicking update joins/proceeds to restart.
  - Background download failed (`updateAvailable && backgroundPhase === "failed"`): show concise notice explaining a new version is available and silent background download failed (with bounded reason), offer a `"重试"` / `"Retry"` primary action, and highlight/display the existing manual update commands and release link.
  - Interactive `npmDownload` progress: render bounded package/percentage text alongside installer byte progress.
  - Active-task confirmation: before calling `startUpdate()`, if `runningTaskCount > 0`, show an explicit confirmation modal stating that restarting will interrupt `N` running session(s) (history is preserved, tasks do not auto-resume).
