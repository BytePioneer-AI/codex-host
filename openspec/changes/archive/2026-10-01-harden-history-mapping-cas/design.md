## Context

**Date:** 2026-09-08. **Status:** Implemented; focused validation passed. See [validation record](validation.md).

Baseline: upstream `4ec37f005c504c4351fc070a79f79bee7158138c`. Mapping Store already owns a single-writer lock, a serialized update queue, record revisions, and atomic file replacement. Both history replacement methods check retained Host Turn prefixes but lack expected-record preconditions. Host rollback also rereads the mutable Runtime record after awaiting native work, which can hide a concurrent change from an otherwise correct Store check.

## Goals / Non-Goals

**Goals:** Reject history replacement against a record other than the one used to prepare it; preserve the latest durable record and indexes on conflict or I/O failure; cover direct last-Turn and legacy Fork-derived rollback.

**Non-Goals:** Native execution fencing, new Adapter capabilities, same-ID rollback removal, full history comparison, source-preserving native rewrites, cross-Thread transactions, or changes to close/commit ordering.

## Decisions

### Compare inside the existing update queue

Add required `expectedRevision` and `expectedNativeSessionRef` to both internal replacement input types. Compare them to the authoritative ready record inside `#update`, before validation or file replacement. Reuse the existing revision and Native Ref comparison conventions, including locator and format version. Do not add a new record schema, lock, counter, or capability.

Checking in Repository alone leaves a queue race. Comparing only the Session ID overlooks a changed locator; comparing only Turn count overlooks configuration and same-length mapping changes. Mismatch raises the existing `MAPPING_CONFLICT` code and leaves memory, durable files, revisions and indexes untouched.

### Preserve the preparation record across awaits

Rollback captures the target record after its admission history refresh and uses that record through derivation and Repository commit. The direct path captures before `adapter.open`; the Fork-derived path captures the target before resolving its parent and captures the source evidence after its refresh. A later assignment to `thread.record` must not silently refresh the expected revision or selected source identity.

Repository forwards the supplied target record's expected identity and revision. It does not fetch a newer record to retry the mutation. Existing persistence-error mapping and candidate cleanup remain unchanged.

### Keep compatibility boundaries explicit

Last-Turn rollback still permits its existing same-Native-ID behavior; Fork-derived rollback retains its existing distinct-ID checks. Neither this change nor a successful compare-and-swap proves the native source was unchanged. Internal TypeScript callers update atomically with the two required fields. Plugin API version, capability schema and stored format remain unchanged.

## Risks / Trade-offs

- A concurrent metadata/configuration update now rejects an old edit even if Turn IDs match → Return the existing persistence failure; do not automatically retry native work.
- Native in-place rewind may have already changed the source before a Store conflict → Existing limitation, handled by the separate native isolation work; do not describe this patch as full rollback atomicity.
- An unrelated parent Thread can change while a Fork-derived target is prepared → Capture source evidence consistently, but this patch only compares the target record; cross-record/native isolation is outside scope.
- Capturing an object reference relies on current immutable record replacement → Verify Runtime/Repository assign fresh Store records and regression-test updates during `open`.

## Validation and observable behavior

Run the unchanged baseline Store, Repository, Runtime and Host tests, then reproduce stale replacement with focused regressions. Test both replacement methods with a queued intervening configuration write, full-ref mismatch, and unchanged same-ID last-Turn behavior. Retain existing persistence-failure tests. Host tests must change the Runtime record during native open to prove the original expectation survives asynchronous preparation.

Validate using the repository Vitest configuration, TypeScript checks, changed-file ESLint/Prettier, the package boundary check, and OpenSpec strict validation. Store failures retain `MAPPING_CONFLICT`; the Host continues to expose its existing rollback persistence error without leaking record contents.

## Migration Plan

Update types, checks, callers and fixtures in the same change. No persisted migration is needed. Reverting the code restores the previous optimistic behavior without making newer records unreadable. No running Desktop or native Harness needs to be started for this patch's deterministic tests.

## Open Questions

None for the bounded record comparison. Native isolation and lifecycle guarantees remain separate work.
