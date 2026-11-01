## 1. Baseline and regression evidence

- [x] 1.1 Run unchanged upstream Store, Repository, Runtime and Host tests and record the baseline.
- [x] 1.2 Add focused stale-record regressions and demonstrate they fail before the fix.

## 2. Expected-record replacement

- [x] 2.1 Require and atomically compare expected Revision and complete Native Session Ref for both Store replacement methods; update existing callers and fixtures.
- [x] 2.2 Capture rollback preparation records across asynchronous native work and forward the original expectations through Repository.
- [x] 2.3 Verify queued updates, source reference mismatch, both rollback paths, same-ID compatibility and persistence-failure recovery.

## 3. Validation and documentation

- [x] 3.1 Run focused regressions, TypeScript, changed-file lint/format and package boundary checks.
- [x] 3.2 Validate the OpenSpec change and document actual results, scope and remaining native-lifecycle limitations.
