## 1. Audit contracts and report model

- [x] 1.1 Define the schema-validated audit report, per-surface evidence levels, verdicts, stable reason codes, and explicit reviewed-baseline comparison.
- [x] 1.2 Add focused tests for report validation, unknown-field rejection, verdict aggregation, state-conditional `unverified` handling, and sanitization.

## 2. Read-only production contract inspection

- [x] 2.1 Add a bounded Renderer inspection owned by `renderer-extension` for Composer, Model, Permission, Settings, Sidebar, Usage/Credits, and Fork contracts without returning content, IDs, Model values, or raw Fiber objects.
- [x] 2.2 Extend `desktop-control` with read-only CDP and Electron Inspector orchestration for primary Renderer selection, request/prewarm ownership, title ownership/readiness observation, and strict inspection-schema validation.
- [x] 2.3 Add focused fixtures and tests proving unique, missing, ambiguous, state-inactive, and unsupported outcomes while preserving production binding behavior.

## 3. Local audit command

- [x] 3.1 Implement `tools/codex-desktop-contract-audit/` argument parsing with loopback-only endpoints, explicit `read-only`/`controlled` modes, optional reviewed baseline, and bounded output paths.
- [x] 3.2 Compose installed Desktop metadata, browser identity, live contract inspection, baseline comparison, verdict aggregation, and sanitized JSON/Markdown report writing behind one command.
- [x] 3.3 Add a root `audit:codex-desktop` npm script and user-facing local tooling documentation with privacy and mode guarantees.

## 4. Controlled escalation

- [x] 4.1 Reuse the existing Renderer Control Session and Renderer binding probe for explicitly requested installation evidence without duplicating production binding logic.
- [x] 4.2 Keep unexercised submission, routing, title creation, Settings interaction, and Fork behavior marked `unverified`, with tests covering the distinction between installation and behavior evidence.

## 5. Validation

- [x] 5.1 Run focused TypeScript tests, typecheck, lint, Renderer build, report-schema fixtures, and `git diff --check`.
- [x] 5.2 Run a read-only local audit against an existing controlled Desktop when available and verify that no reload, injection, submission, or user-data persistence occurs.
- [x] 5.3 Run an isolated controlled audit when the local Desktop permits, record which behavior boundaries were and were not exercised, and validate the OpenSpec change.
