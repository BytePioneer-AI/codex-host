## 1. Contracts and Product Baseline

- [x] 1.1 Add strict browser-safe update check, start, status, phase, and result schemas with focused Shared Contracts tests.
- [x] 1.2 Update the PRD, engineering baseline, and development checklist so GitHub Releases discovery and user-triggered self-update are confirmed behavior rather than an undecided mechanism.

## 2. Release Discovery and Installed Context

- [x] 2.1 Add a strict GitHub latest-Release client and SemVer/asset selector using the exact repository, target filename, asset size, and GitHub SHA-256 digest.
- [x] 2.2 Add installed distribution/runtime context resolution for npm, Windows installer, and macOS installer layouts without accepting Renderer-provided paths.
- [x] 2.3 Add latest-status discovery, serialized operation locking, stale terminal cleanup, and focused Update Manager tests.

## 3. Managed Shutdown Control

- [x] 3.1 Pass the exact Launcher PID, executable, Controller port, and nonce through the managed Desktop environment and preserve npm-only absolute update paths from the npm launcher.
- [x] 3.2 After the update Helper is started or reports `waiting-for-exit`, the Launcher stops the owned Desktop process tree and exits. Do not quit Desktop through Controller Inspector `app.quit()`.
- [x] 3.3 Add Launcher tests for prepared Helper start versus waiting-for-exit Desktop stop, and Controller tests that the retired SHUTDOWN command is rejected.

## 4. Host Update Composition

- [x] 4.1 Compose Release discovery, installed context, Update Manager, operation serialization, and status recovery in one Host-owned update coordinator.
- [x] 4.2 Route only fixed `codexhost/update/check`, `codexhost/update/start`, and `codexhost/update/status` requests and reject malformed or privileged input.
- [x] 4.3 Add Host tests for no update, installable update, missing digest, duplicate start, macOS Helper hand-off, status recovery, and GitHub failure.

## 5. Renderer Update Experience

- [x] 5.1 Extend the existing method-specific Renderer client with strict check, start, and status methods.
- [x] 5.2 Add localized Updates settings navigation and page UI for current/latest version, bounded plain-text Release body, release-notes link, update-and-restart, bounded pending states, retry, and post-restart result.
- [x] 5.3 Add page/client/lifecycle tests covering stale request cancellation, malformed Host results, duplicate activation, terminal recovery, responsive layout, and unchanged settings disposal.
- [x] 5.4 Add installer download progress status, asynchronous Host preparation, percentage rendering, and failure-state recovery tests.

## 6. Release and Verification

- [x] 6.1 Add release-contract checks that the four published asset names remain exact and document that GitHub API asset size/digest are the update inputs without adding release files.
- [x] 6.2 Run focused TypeScript/Rust/release tests, `npm run check`, `npm run build`, strict OpenSpec validation, and `git diff --check`; resolve affected failures.
- [ ] 6.3 Perform real old-to-new npm and macOS arm64 upgrade/relaunch/failure recovery gates on the current host and record only observed results.
- [ ] 6.4 Perform real Windows x64, Windows ARM64, and macOS x64 upgrade gates on native target hosts before marking those targets verified.
