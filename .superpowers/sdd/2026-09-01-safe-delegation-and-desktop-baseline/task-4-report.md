# Task 4 report

## RED

The default official delegation test failed because `thread/start` still sent `approvalPolicy: "never"` and `sandbox: "danger-full-access"`; the expected safe defaults were `on-request` and `workspace-write`.

## GREEN

- `npm run build:typescript` — passed
- `npx vitest run packages/host-runtime/test/app-server-host.test.ts --config tests/vitest.config.js` — 117 tests passed

## Changed files

- `packages/host-runtime/src/app-server-host.ts`
- `packages/host-runtime/test/app-server-host.test.ts`

## Self-review

The official path normalizes the omitted policy to `approval-required`, includes it in the digest, maps it to the safe native request, and returns policy evidence for both new and idempotent results. Explicit `unattended-full-access` retains `never`/`danger-full-access`; request-ID reuse with a different policy is rejected.

## Concerns

No known concerns. Third-party adapters were not modified.

## REVIEW FIX

- RED: the explicit `unattended-full-access` first request succeeded, but its official persisted record omitted `executionPolicy`; a same request-id retry therefore returned the backward-compatible safe fallback `approval-required` evidence.
- GREEN: after persisting the normalized policy, `npm run build:typescript` passed and the focused app-server test passed with 117 tests.
- Fix: added `executionPolicy` to the official `createDelegation` record and regression coverage for explicit unattended idempotent retry.
- Self-review: old records without the field remain safe via `existing.executionPolicy ?? "approval-required"`; no third-party adapter or unrelated path changed.
- Concerns: none known.
