# Tasks: Background Update Staging & Failure Fallback

1. **Extend shared update check contract** (`packages/shared-contracts/src/updates.ts` & `test/updates.test.ts`)
   - Add optional `stagedVersion`, `backgroundPhase`, `backgroundDownload`, `backgroundError`, and `runningTaskCount` fields to `updateCheckResultSchema`.
   - Verify: `npx tsc -b packages/shared-contracts && npx vitest run --config tests/vitest.config.js packages/shared-contracts/test/updates.test.ts`.

2. **Add staged cache layer & reuse in Update Manager** (`packages/update-manager/`)
   - Add ETag / `If-None-Match` support to GitHub Release discovery.
   - Add `staged/` storage, `staging-v1.lock`, `stageArtifact`, `stageNpm`, `readStagedUpdate`, `cleanupStagedUpdates` (retaining at most one version, clearing obsolete versions when `currentVersion >= staged.version`).
   - Extend `prepareCommon` / `prepareNpm` to verify and reuse valid staged artifacts/cache with seamless fallback to live download when missing or corrupted.
   - Verify: `npx tsc -b packages/update-manager && npx vitest run --config tests/vitest.config.js packages/update-manager/test/`.

3. **Add silent background scheduler & running task count in Host Runtime** (`packages/host-runtime/` & `packages/console-server/`)
   - Add periodic background check + silent staging + bounded retry backoff (max 2 auto retries per version) + deduplicated join when `start()` overlaps active staging + clean `dispose()` in `HostUpdateCoordinator`.
   - Ensure background staging failures never write `status-v1.json`, never stop services, and surface `updateAvailable: true` + `backgroundPhase: "failed"` + bounded `backgroundError`.
   - Pass `runningTaskCount` from `AppServerHost` (`runningThreadIds().length`) into `HostUpdateCoordinator`.
   - Verify: `npx tsc -b packages/host-runtime packages/console-server && npx vitest run --config tests/vitest.config.js packages/host-runtime/test/update-coordinator.test.ts packages/console-server/test/updates.test.ts`.

4. **Update shared Updates page & Web/Desktop entry triggers** (`packages/renderer-extension/` & `apps/web-ui/packages/client/ui-codexhost/`)
   - Update `pages.ts` & `localization.ts` (zh/en): ready-to-restart CTA (`重启以更新` / `Restart to update`), background-download-failed banner with **Retry** button + highlighted manual commands/release link, live `npmDownload` progress display, and confirmation dialog when `runningTaskCount > 0`.
   - Update `trigger.ts`, `renderer-settings-lifecycle.ts`, and `apps/web-ui/.../SettingsLauncher.tsx` so badges stay lit on both ready and background-failed states, tooltips switch to ready-to-restart when staged, and long-lived sessions periodically refresh check state.
   - Capture and inspect sanitized UI screenshots covering ready-to-restart, background-failure fallback (with retry + manual instructions), and active-task confirmation states.
   - Verify: `npx tsc -b packages/renderer-extension && npx vitest run --config tests/vitest.config.js packages/renderer-extension/test/settings/ && npm run build:renderer` (and `node --import tsx apps/web-ui/scripts/build.ts` if web-ui deps are linked).
