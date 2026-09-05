## Context

The supported Codex Desktop build (26.901.22334 with app-server 0.153.0) uses paginated history and implements message editing as `thread/revert { threadId, beforeTurnId }` followed by a replacement `turn/start`. Its generated `ThreadRevertResponse` requires `thread`, `turnsBackwardsCursor`, and `itemsBackwardsCursor`. The Renderer destructures both cursors to reset canonical Turn and Item pagination.

codexhost already recognizes `thread/revert` for a mapped external Thread, requires paginated history, verifies that `beforeTurnId` is the latest completed Host Turn, creates a replacement Native Session through the Adapter's exact last-Turn rollback operation, atomically replaces stored Native refs, and emits `thread/reverted`. The response projector currently returns only `{ thread: { ...thread, turns: [] } }`, which is no longer a complete response for the current Desktop contract.

The audit also found three implementations that overstated the existing `history.rollbackLastTurn` contract. OpenCode called `session.revert`, which mutates the source Session and restores Git-backed project files. Grok called a conversation-only Rewind that leaves files alone but still rewrites the source Session in place. Claude Code could Fork a non-empty retained prefix, but represented a one-Turn rollback as a lazy UUID with no durable Native Session, so the empty replacement could not survive recovery. Pi and OMP already derive a distinct replacement for both empty and non-empty prefixes.

The update-impact audit compared the installed generated protocol and the current Renderer bundle with the older last-message-edit design. It found a protocol-response drift from the previous rollback-oriented flow to the current revert response, but no missing Renderer edit callback or version-gate problem. A focused red test reproduces the missing fields without depending on private transcript content.

## Goals / Non-Goals

**Goals:**

- Return the exact required paginated revert response shape for supported external latest-message edits.
- Reuse the same opaque cursor format and ordering semantics already used by external resume, `thread/turns/list`, and `thread/items/list`.
- Prove empty and non-empty retained histories, notification ordering, and edited replacement Turn continuity.
- Defend the distinct, source-preserving rollback invariant at every commit boundary and make capability reporting honest.
- Keep official Codex requests transparent and external failures fail-closed.

**Non-Goals:**

- Implement arbitrary-boundary external history rewrite or active-Turn interruption.
- Change the deprecated `thread/rollback` response or add a generic arbitrary-prefix operation.
- Add Renderer controls, infer transcript content, revert project files, or change the Mapping Store format.
- Make Grok's in-place Rewind satisfy a distinct-session contract or remove its private low-level Rewind implementation.

## Decisions

### Derive both response cursors from committed retained history

After the Native rollback and Mapping Store commit succeed, Host derives the Turn cursor with `listExternalTurns(..., { limit: 1, itemsView: "notLoaded" })` and the Item cursor with `listExternalItems(..., { limit: 1, sortDirection: "desc" })`. This matches the existing paginated resume path and keeps cursor serialization owned by `external-thread-history`.

Passing explicit cursor values into `threadRevertResult` makes the protocol projection exact and independently testable. Computing a second cursor format in `protocol-core`, returning placeholders, or omitting empty-history fields would create divergent pagination semantics and is rejected.

### Enforce distinct, source-preserving last-Turn derivation

`history.rollbackLastTurn=true` continues to mean that `open(rollbackLastTurn)` returns a different Native Session whose history is semantically the source prefix without its final Turn. The derivation may regenerate Native Session, message, Turn, Checkpoint, and Item IDs; retained order, input, Item semantics and outcomes, Turn outcome, Model, and Checkpoint presence must remain equal. The operation also leaves the source Session and project files unchanged. Host rejects a same-ID Session result before reading or committing it; Repository repeats the Session identity check; Mapping Store requires a distinct replacement plus the expected source ref and revision. These layered checks prevent an Adapter bug or stale write from silently rebinding a Thread after an in-place mutation.

OpenCode can meet the contract with `session.fork({ messageID: lastUserMessageID })`, whose boundary is exclusive. This also handles a one-Turn source by producing an empty distinct Session. The Adapter restores its confirmed model, variant, and permission mode, verifies that exactly one Turn was removed, deletes the derived Native Session if its own validation or attachment fails, and never calls file-restoring `session.revert`. Retained `FileChange` comparison uses strict diff projection for the source, candidate, post-fork source, and the candidate's later Host pre-commit snapshot: every returned diff entry must be reliable and every file named by a Native patch must be covered. OpenCode exposes patch files as absolute paths while Git-backed diffs are worktree-relative, so strict comparison reads the authoritative `/path` worktree, resolves both representations to canonical in-worktree file identities, and rejects inconsistent Session/path metadata or paths that escape the worktree. A path or diff API failure, malformed or partial diff set, or a Native patch that never reconciles to reliable diffs rejects the rollback instead of comparing incomplete history. Ordinary non-rollback reads remain best-effort. If a later Host commit fails, the generic contract can close the returned wrapper and preserve the source/Store/runtime authority, but it cannot promise Native deletion without an Adapter-owned delete operation.

Grok's available `conversation_only` Rewind deliberately reuses and mutates the source Native Session. Claude Code cannot currently persist a distinct empty Session before its first replacement Turn. Until either Harness exposes or codexhost proves a distinct, durable derivation for both non-empty and empty retained prefixes, its inspection and opened Sessions report `rollbackLastTurn=false`, and direct `open(rollbackLastTurn)` fails before reading history or starting a transport.

### Fence the source before committing history replacement

`history.replacementFence?: boolean` explicitly separates ordinary Session cleanup from a `close()` that can fence Adapter-controlled Native work, transcript writes, and workspace mutation. Omission remains valid for Adapters that do not claim rollback and means false; an older rollback-capable producer must add the explicit fence claim or fail closed. The shared schema requires `rollbackLastTurn=true` to pair with `replacementFence=true`; Pi, OMP, OpenCode, and the Fake report the fence, while adapters without a proven close fence omit it or report false.

Host rejects both direct last-Turn rollback and legacy Fork-derived rollback before candidate derivation when the current authoritative Session lacks the fence. A returned candidate must also report the fence before Host restores configuration or reads its history, so a replacement cannot weaken the invariant after commit. Session capabilities are lifetime-invariant by contract; Runtime nevertheless rechecks both the current Session and reserved candidate after asynchronous candidate validation, immediately before it calls `close()` and enters the Store commit phase.

After validating the requested boundary, Runtime acquires an idle history-mutation reservation on the exact loaded Thread. Source output observed while the replacement is still being derived invalidates the mutation, waits behind its gate, and resumes on the still-authoritative source after revert fails.

Once the candidate is fully validated, Runtime atomically enters a fencing phase, closes the old Session, and drains its output task. For a Session with `replacementFence=true`, `close()` resolution proves Adapter-controlled work has stopped, the output iterable will terminate after already-emitted values, and no later Native transcript or workspace mutation is possible. Output that reaches Runtime during fencing invalidates the mutation and is drained without live projection; the closed wrapper is then unloaded and the unchanged Mapping Store record cold-resumes the source on the next access. Runtime also rejects fencing when another loaded Thread owns the source wrapper or Native identity.

Only a clean fence advances to the commit phase. The Mapping Store then performs its revision-and-source-identity CAS while no old Session can start a Turn or tool. On persistence failure, Host closes the candidate, unloads the already-closed source wrapper, and leaves the original durable record authoritative for cold recovery. On success, Runtime publishes the reserved candidate. This removes the prior window in which old Native side effects could occur during an asynchronous Store write and then be silently discarded.

The candidate Session receives a second Runtime reservation before Host restores configuration or reads history. Runtime rejects any wrapper or Native Session identity already owned by any loaded external Thread and never closes an owned Session during error cleanup. The same reservation is required at the commit and runtime-swap boundaries, preventing a faulty Adapter from modifying or retiring an unrelated authoritative Thread.

Every asynchronous operation against the authoritative Session also holds a Runtime access lease until its Native work settles. This includes live configuration changes, command catalog discovery, and an exact Usage refresh even though that refresh returns its cached response immediately. A history mutation cannot begin while a lease is held, and a new access is rejected once mutation begins, so source `close()` cannot race an in-flight Session call introduced by another Host route.

Pi, OMP, and OpenCode additionally compare identity-normalized retained history as complete semantic Turns rather than trusting counts or Native keys. A derivation may allocate fresh Native Session, message, Turn, Checkpoint, Item, and Subagent IDs, so those identifiers are excluded from cross-Session equality. Turn order, Native Ref kind and format compatibility, input, Item semantics and outcomes, Turn outcome, and Model must remain equal, and each corresponding Turn must preserve whether a Checkpoint exists. A derived transcript with altered semantic content or Checkpoint presence is rejected and cleaned up before the source fence.

Live history refresh uses a separate Runtime-owned lease. It may re-project only Native Turns that already have stable persisted Host mappings; it never invents a Host Turn ID for previously unseen activity on a loaded Session. If output appears while `readSnapshot()` is pending, or the Snapshot contains an unknown Native Turn, refresh returns busy and releases the event stream to perform the authoritative live projection. This prevents refresh and terminal output from assigning two Host IDs to one Native Turn.

### Preserve the bounded latest-message mutation

This fix retains the current admission rule: `beforeTurnId` must equal the latest completed mapped Turn, the Thread must be idle and paginated, and the Adapter must support exact last-Turn rollback. These conditions match the current Desktop edit affordance, which only enables its most recent user message and disables editing during an active Turn.

General `thread/revert` parity requires a distinct design: an Adapter capability that can atomically derive any prefix, including an empty prefix, plus CAS-protected Mapping Store replacement and explicit active-Turn cancellation semantics. Expanding the current last-Turn operation or looping it would overstate Adapter guarantees and make partial failure compensation unsafe, so it is not bundled into this compatibility fix.

### Respond before notifying, then continue on the replacement Session

Host returns the response only after the replacement Native Session and retained mapping prefix are committed. It then emits one `thread/reverted` notification. The following edited `turn/start` resolves the same Host Thread to the replacement runtime Session; no official Codex shadow Thread is created.

## Risks / Trade-offs

- **[Cursor contract drifts again]** → Keep an exact protocol-core response assertion and Host-level non-empty/empty cursor assertions tied to the generated current schema.
- **[A retained Item or Turn has no stable ID within its owning Session]** → Reuse history pagination validation; successful rollback history is already projected from validated snapshots. Cross-Session derivation may still allocate different stable IDs.
- **[A Native rollback succeeds but the replacement cannot continue or recover]** → Exercise empty and non-empty continuable replacements in capable Adapter and Host tests; report Claude Code unsupported because its empty lazy Session is not recoverable.
- **[An Adapter mutates or aliases its source]** → Require a distinct Native Session at Adapter, Host, Repository, and Store boundaries; keep Grok disabled and run OpenCode's real Edit Tool Gate with source/history/file isolation assertions.
- **[A stale replacement overwrites newer Thread state]** → Compare the expected Mapping Store revision and exact current Native Session ref within the serialized atomic update.
- **[An autonomous Turn starts while history is being replaced]** → Reserve the idle runtime before Adapter work; derivation-time output invalidates and later projects, then close and drain the source as a native fence before the asynchronous Store commit. Fence-time output invalidates and forces cold recovery from the unchanged source mapping.
- **[Store persistence fails after the source fence]** → Unload the closed wrapper, close the uncommitted candidate, retain the original CAS-protected record, and prove the next request cold-resumes that Native Session.
- **[A derived transcript changes retained semantics while preserving or regenerating IDs]** → Compare identity-normalized complete retained Turns in each capable Adapter and cover input, Item, Outcome, Model, and Checkpoint-presence corruption.
- **[OpenCode cannot reliably project every retained file diff]** → Keep rollback-created Sessions in strict FileChange mode through Host pre-commit validation, anchor absolute Patch and relative diff paths to the authoritative OpenCode worktree, and reject path/diff transport failure, inconsistent or escaping paths, malformed entries, partial Patch-file coverage, or unreconciled Native patches; leave ordinary history reads best-effort.
- **[A live history read races terminal output]** → Serialize refresh through Runtime and project only already-mapped Native Turns; unknown activity returns busy so the event stream remains the sole mapping authority.
- **[Another Host route is still awaiting the source Session]** → Hold a Runtime access lease through configuration, command discovery, and exact Usage refresh work; reject history replacement until every lease settles.
- **[A faulty Adapter returns another Thread's Session]** → Reserve wrapper and Native identity before configuration or history access, reject every loaded-owner collision, and close only unowned candidates.
- **[A legacy or inconsistent Session lacks a Native-work fence]** → Treat an omitted capability as false, reject before direct or fallback derivation, reject a candidate that weakens the capability, and recheck at Runtime commit preparation.
- **[Users infer arbitrary message editing support]** → State the latest-message boundary explicitly in proposal, spec, errors, and PR description; unsupported boundaries continue to fail without changing state.

## Migration Plan

No data migration is required. The response and commit preconditions change, but the stored record schema does not. Existing Grok and Claude Code Threads remain readable and usable; only last-message rollback is rejected. Reverting the commit restores the prior capability reporting and response behavior, but would re-enable unsafe or unrecoverable rollback paths.

## Open Questions

None for this bounded compatibility fix. Arbitrary-prefix and active-Turn revert belong to a separate capability proposal with per-Adapter native proof.
