# Task 10 report

## RED

Added HTTP trust-boundary tests for `default`, unknown policy, wrong scalar, and unknown fields. They initially returned 200 and reached the API. Added request-id retry evidence and concurrent external start coverage; the new retry assertion initially lacked persisted policy evidence.

## GREEN

Added strict Zod validation for all delegation control routes, with delegation policy limited to approval-required/unattended-full-access and INVALID_ARGUMENT responses. Added serialized MappingStore create mutations, coordinator start serialization, persisted policy restoration for idempotent retries, and moved provisional creation inside coordinator cleanup. Focused build plus control-server/coordinator/mapping-store tests pass: 3 files, 45 tests.

## Commits

Pending in this task's follow-up commit.

## Concerns

The MappingStore serialization is a single mutation queue: deliberately simple and safe, with throughput bounded by serialized creates. Official request dedupe remains owned by the official Host implementation; this task only ensures normalized policy reaches that path and avoids changing native mapping behavior.
