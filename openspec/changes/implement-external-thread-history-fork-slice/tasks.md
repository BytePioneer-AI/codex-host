## 1. Public history and Fork contract

- [x] 1.1 Extend Shared Contracts with fixed Thread inspection schemas and history-capable Session capability shape
- [x] 1.2 Extend HarnessAdapter with create/resume/fork open inputs, Snapshot types, Native terminal identity, Checkpoint outcomes, and `readSnapshot()`
- [x] 1.3 Extend Fake HarnessAdapter and contract tests for deterministic Snapshot, resume, exact Fork, unsupported capability, and derived identity isolation

## 2. External Thread Mapping Store

- [x] 2.1 Implement strict V1 stored Thread and Turn schemas including Desktop timeline and Fork source metadata
- [x] 2.2 Implement initialization, exclusive lock, indexes, provisional create, atomic commit/update, lookup, and cleanup APIs
- [x] 2.3 Add Mapping Store tests for restart, uniqueness, forbidden content, write failure, backup recovery, provisional cleanup, and Fork commit failure

## 3. Pi history, resume, and Fork

- [x] 3.1 Add typed Pi RPC resume argv and `get_entries`, `fork`, and `clone` operations without exposing native types outside PiAdapter
- [x] 3.2 Implement active-branch Pi Snapshot mapping with stable Turn, Item, outcome, Model, and Checkpoint identities
- [x] 3.3 Attach persisted NativeTurnRef and Checkpoint to live Pi Turn terminals and preserve identity across repeated reads
- [x] 3.4 Implement Pi `open(resume|fork)` with dynamic non-tail Fork versus tail Clone, exact cutoff verification, source isolation, and inherited state
- [x] 3.5 Add Pi transport and Adapter tests for resume, append stability, inactive branches, non-tail Fork, tail Clone, stale Checkpoint, and current-file preservation

## 4. Protocol and Host routing

- [x] 4.1 Add current Codex `thread/fork` decoder, historical Snapshot projector, and bounded error mapping in Protocol Core
- [x] 4.2 Extract persisted external Thread repository/runtime helpers from `AppServerHost` and wire Mapping Store initialization and shutdown
- [x] 4.3 Persist external create identity, NativeSessionRef state changes, and live Turn mappings before terminal projection
- [x] 4.4 Restore persisted external `thread/read` and `thread/resume` on demand through Adapter Snapshot APIs
- [x] 4.5 Route external `thread/fork`, resolve inclusive/exclusive/tail boundaries, commit derived mappings, and return current `ThreadForkResponse`
- [x] 4.6 Preserve official Codex Fork passthrough and add Host tests for ownership, ordering, errors, source isolation, restart, and derived continuation
- [x] 4.7 Keep development-gated Claude explicit by implementing the expanded interface with honest unsupported history/Fork results
- [x] 4.8 Decode and ownership-route the supported Desktop post-Fork `thread/rollback`, atomically replace the untouched derived prefix with an exact Fork Session, and test passthrough, truncation, identity stability, and failure recovery

## 5. Renderer ownership restoration

- [x] 5.1 Add the fixed browser-safe `codexhost/thread/inspect` client and Host handler without exposing Native refs or generic requests
- [x] 5.2 Initialize unbound conversation Composers from generation-scoped Host ownership as locked external or official Codex state
- [x] 5.3 Apply Host-confirmed Pi Model state, block unresolved external submission, and ignore stale or mismatched inspection results
- [x] 5.4 Add Renderer controller, client, DOM state, fork mount, revisit, failure, and stale-response tests

## 6. Validation and baselines

- [x] 6.1 Generate and inspect current Codex protocol bindings for Fork and rollback request/response, capture the supported Desktop message-action request shape, and record only sanitized protocol facts
- [x] 6.2 Run focused package tests, `npm run check`, and `npm run build`; resolve all affected failures
- [ ] 6.3 Run a controlled real Codex Desktop/Pi non-tail and tail Fork Gate, verify source/derived independent continuation and `Pi / locked`, and save only sanitized evidence
- [ ] 6.4 Run official Codex Fork regression, update affected architecture/development status documents, and record the final validation conclusion
