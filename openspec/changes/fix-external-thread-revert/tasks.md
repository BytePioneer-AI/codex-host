## 1. Protocol Contract

- [x] 1.1 Extend the `threadRevertResult` projection with both required nullable pagination cursors.
- [x] 1.2 Add an exact protocol regression test for the complete metadata-only `ThreadRevertResponse`.
- [x] 1.3 Reassert distinct, source-preserving `rollbackLastTurn` semantics and make Grok plus Claude Code report unsafe or non-durable rollback paths as unsupported.
- [x] 1.4 Add the optional, fail-closed `history.replacementFence` capability, require it for `rollbackLastTurn`, and document the conditional `HarnessSession.close()` fence contract.

## 2. Host Integration

- [x] 2.1 Derive Turn and Item backwards cursors from the committed retained external history using the existing pagination implementation.
- [x] 2.2 Verify non-empty and empty retained histories, response-before-notification ordering, and replacement `turn/start` continuity.
- [x] 2.3 Preserve explicit failure and official pass-through behavior for out-of-scope revert requests.
- [x] 2.4 Add Host, Repository, and Mapping Store defenses for same-identity and stale replacement attempts.
- [x] 2.5 Derive OpenCode rollback through an exclusive transcript Fork and verify source Session plus workspace isolation.
- [x] 2.6 Serialize runtime history replacement against racing Session output, let pre-commit Native activity invalidate derivation, and cover the autonomous-Turn race.
- [x] 2.7 Reserve replacement identity before access, reject aliases of every loaded Thread without closing them, and serialize live refresh without inventing mappings for unknown Native activity.
- [x] 2.8 Deep-compare identity-normalized retained Turn semantics in capable Adapters, allow Fork-regenerated Native IDs, and reject semantic or Checkpoint-presence corruption.
- [x] 2.9 Fence and drain the old Native Session before the asynchronous Store commit, with cold-resume recovery after fence-time invalidation or persistence failure.
- [x] 2.10 Gate direct and legacy Fork history replacement on source and candidate fence capabilities, recheck both at Runtime commit preparation, and cover legacy/inconsistent/late-downgrade negative paths.
- [x] 2.11 Extract cold resolution and read-only Subagent recovery from the concurrency-critical Runtime, preserving restore coalescing and failure cleanup while keeping the history state machine cohesive.
- [x] 2.12 Make OpenCode rollback `FileChange` projection fail closed through the Host pre-commit snapshot, including authoritative worktree path identity, malformed or escaping paths, and partially covered multi-file diffs, while keeping ordinary history reads best-effort.
- [x] 2.13 Fence v0.5 Session command discovery and exact Usage refresh calls from racing history replacement, including fire-and-forget Native work.

## 3. Validation and Handoff

- [x] 3.1 Run TypeScript build and focused protocol, Mapping Store, Adapter, and Host tests.
- [x] 3.2 Run formatting, lint/type checks relevant to the changed packages, validate the OpenSpec change, and run the real OpenCode rollback Gate.
- [ ] 3.3 Commit the isolated branch, push it to the public fork, and open an upstream PR with purpose, scope, and executed checks.
