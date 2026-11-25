## Context

Independent submission base: upstream `e8f8ecd`. Old PR #158 contains the relevant history attribution evidence; newer upstream already supports rollback and must retain that capability.

## Decisions

An interruption record must have exactly one recognized text block, match the current human promptId, and omit promptSource. Text alone is insufficient. Attribute it to the existing Turn, mark cancellation and retain its UUID as the checkpoint.

Before emitting completion, retain the current Turn's known user UUID and checkpoint UUID. Snapshot reads poll within the existing close timeout until both appear. Return retryable sessionBusy on timeout and retain the expectation for a later read. Track only the most recently completed Turn so later native compaction does not require obsolete IDs. Existing history validation still runs on the resulting messages.

## Risks and limits

This proves observed live messages are present, not that all native background execution stopped. Cold resume has no live completion evidence and retains existing missing-history errors. Native record metadata is version-sensitive; native CLI validation must record actual versions. No pending records or process-fence contract is introduced here.

## Validation

Three old-history regressions fail on unchanged upstream. Cover literal strings, distinct prompt IDs, explicit promptSource, interruption before assistant output, delayed persistence, timeout and later successful retry. Run the owning Adapter tests and TypeScript/lint/format checks. Native CLI validation must record the actual version and environment separately.
