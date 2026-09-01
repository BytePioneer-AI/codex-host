# Task 10 report

## RED

Added HTTP trust-boundary tests for `default`, unknown policy, wrong scalar, and unknown fields. They initially returned 200 and reached the API. Added request-id retry evidence and concurrent external start coverage; the new retry assertion initially lacked persisted policy evidence.

## GREEN

Added strict Zod validation for all delegation control routes, with delegation policy limited to approval-required/unattended-full-access and INVALID_ARGUMENT responses. Added serialized MappingStore create mutations, coordinator start serialization, persisted policy restoration for idempotent retries, and moved provisional creation inside coordinator cleanup. Focused build plus control-server/coordinator/mapping-store tests pass: 3 files, 45 tests.

## Commits

Pending in this task's follow-up commit.

## Concerns

The MappingStore serialization is a single mutation queue: deliberately simple and safe, with throughput bounded by serialized creates. Official request dedupe remains owned by the official Host implementation; this task only ensures normalized policy reaches that path and avoids changing native mapping behavior.

## SECOND FIX

### RED

The review regressions targeted unconstrained IDs/harness values at the HTTP boundary and post-write index failure leakage. The existing route schemas accepted these values and dispatch casts bypassed domain contracts.

### GREEN

Control schemas now use the existing routed-harness, branded model/thinking, and host-thread parsers, transform optional fields without undefined leakage, and dispatch parsed contract values without assertions. Mapping Store create writes snapshot/restore indexes and remove newly written files on post-write failure; the mutation queue remains usable. Focused build plus control-server/coordinator/mapping-store suites pass: 3 files, 45 tests.

### Commit

Pending in this follow-up commit.

### Remaining concern

Official concurrent behavior is serialized by the coordinator start queue; no native mapping changes were made.

## THIRD FIX

### RED

Added rollback fault injection after the provisional write, concurrent external identical/conflicting request coverage, and an injected official Codex Promise.all idempotency/conflict matrix. The pre-fix boundary still had an unused import lint failure and lacked the post-write rollback regression.

### GREEN

Control-server schemas retain only contract-compatible parsers with no dispatch assertions. MappingStore now restores all indexes and removes a newly written file when post-write rebuild fails, while later queued creates succeed. External and injected official concurrency matrices assert one creation for identical requests and no additional creation for conflicts. Build passed; four focused files passed with 164 tests, and changed-file ESLint passed.
