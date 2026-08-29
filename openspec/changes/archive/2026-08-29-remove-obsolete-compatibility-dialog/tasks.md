## 1. Readiness and Launcher cleanup

- [x] 1.1 Reduce Controller and Launcher readiness schemas to the strict compatible-only production payload and update focused serialization/parsing tests.
- [x] 1.2 Remove Launcher compatibility decisions, warning acknowledgement persistence, compatibility-only release/stock actions, and their focused tests while preserving normal startup supervision and malformed-readiness failure.

## 2. Platform dialog cleanup

- [x] 2.1 Remove compatibility-only prompt types, exports, macOS/Linux implementations, and the compatibility section of Windows UI without changing running-Desktop or error dialogs.

## 3. Compatibility update bridge cleanup

- [x] 3.1 Remove the Launcher `COMPATIBILITY_UPDATE` client and Controller attachment command while retaining authenticated `ATTACH` behavior.
- [x] 3.2 Remove `requestCompatibilityUpdate` from Renderer Control Session and production Controller composition.
- [x] 3.3 Remove the Renderer binding compatibility-update API/module and its tests while preserving Settings `checkUpdate`, `startUpdate`, and `readUpdateStatus` operations.

## 4. Validation

- [x] 4.1 Run repository searches proving no active compatibility-dialog or dedicated update symbols remain outside historical archived artifacts.
- [x] 4.2 Run focused TypeScript tests/type checks and Rust Launcher/Platform tests or checks.
- [x] 4.3 Build and launch codexhost with `npm start` when the local Desktop environment permits, verify managed startup/attachment and Settings update availability, and report any blocked live checks.
- [x] 4.4 Validate the OpenSpec change and run `git diff --check`.
