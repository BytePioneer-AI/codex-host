## 1. Controller Readiness Contract

- [x] 1.1 Remove the four blocking capability/reason outcomes and incompatible/detection-failed states from the production Controller readiness serializer.
- [x] 1.2 Remove compatibility-boundary error wrapping from the Renderer Control Session while retaining underlying installation and point-of-use validation.
- [x] 1.3 Update focused readiness and Control Session tests for the reduced non-blocking protocol.

## 2. Recoverable Controller Lifecycle

- [x] 2.1 Refactor production Controller lifecycle to retain an optional serialized Renderer Session after initial installation failure.
- [x] 2.2 Start authenticated attachment service and publish managed readiness after a suppressed initial failure, then retry complete installation without exiting.
- [x] 2.3 Reset and retry a Session that loses Renderer readiness while keeping external capability unavailable until recovery.
- [x] 2.4 Add focused tests for classified failures, inspection failures, attachment during recovery, successful retry, and post-ready Session loss.

## 3. Launcher And Native Compatibility Cleanup

- [x] 3.1 Remove the four blocking readiness outcomes from Launcher parsing, compatibility decisions, compatibility-update branching, and tests.
- [x] 3.2 Remove blocking compatibility-boundary labels, text, and choices from Windows/macOS platform prompts while preserving non-blocking warning/degraded behavior.
- [x] 3.3 Update release bundle assertions so published Controller and Host artifacts no longer require the removed startup error/update path.

## 4. Product And Architecture Baseline

- [x] 4.1 Update the PRD, engineering baseline, development checklist, and compatibility design for non-blocking managed startup and local external-capability readiness.
- [x] 4.2 Reconcile affected main OpenSpec requirements with the new non-blocking behavior.

## 5. Verification

- [x] 5.1 Run focused Desktop Controller, Renderer Control Session, Launcher, platform, Host release, and Controller release tests.
- [x] 5.2 Run affected TypeScript/Rust checks, strict OpenSpec validation, and git diff validation; report any real Desktop login recovery Gate not executed.
