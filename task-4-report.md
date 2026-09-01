# Task 4 report

- RED: after changing the official delegation expectation, the focused app-server test failed because `thread/start` still sent `never` and `danger-full-access`.
- GREEN: `npm run build:typescript && npx vitest run packages/host-runtime/test/app-server-host.test.ts --config tests/vitest.config.js` — 117 tests passed.
- Files: `packages/host-runtime/src/app-server-host.ts`, `packages/host-runtime/test/app-server-host.test.ts`.
- Self-review: normalized the policy once at the official boundary; included it in the digest, native request mapping, initial result evidence, and idempotent result evidence. Explicit request-id reuse with a different policy is rejected.
- Concerns: no known concerns; unrelated adapters were not changed.
