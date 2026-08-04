## Context

A real Claude Code Session showed two native `user` records inserted by model selection between already mapped conversation Turns: a `<command-name>/model</command-name>` envelope and `<local-command-stdout>Set model to ...</local-command-stdout>`. `mapClaudeSnapshot()` currently classifies every text-bearing `user` record as human. `ExternalThreadRepository.alignSnapshot()` correctly verifies that persisted identities remain a subsequence of the Native Snapshot, but then calls append-oriented `upsertTurnMappings()`. A first recovery from `[A, D]` against `[A, B, C, D]` therefore persists `[A, D, B, C]`; a second recovery rejects that order.

Paseo independently classifies Claude transcript noise at its Provider boundary, including exact local-command output wrappers, before creating user Timeline entries. It also avoids this exact alignment failure by owning a persistent Timeline rather than a Host-to-Native identity sequence. codexhost can borrow the boundary-classification approach, but its PRD requires the Native Session to remain the only Transcript source and Mapping Store identities to support exact Fork and rollback.

## Goals / Non-Goals

**Goals:**

- Exclude Claude local-command metadata and model-selection control records from human historical Turns.
- Keep genuine human text and supported slash-command prompts visible.
- Persist newly discovered legitimate Native Turns in complete Snapshot order.
- Preserve stable Host Turn IDs, identity uniqueness, Checkpoint monotonicity, and fail-closed order validation.
- Prove that two consecutive recoveries converge to the same ordered mapping set.

**Non-Goals:**

- Persist a Paseo-style normalized Timeline or any second Transcript.
- Ignore arbitrary Snapshot mismatches, deleted Native Turns, reordered existing Turns, or changed identity associations.
- Change Claude SDK model-selection behavior or route slash commands in Host Runtime.
- Automatically rewrite the diagnosed live revision or mutate a Claude Native Session.

## Decisions

### 1. Classify transcript noise at the Claude Adapter boundary

The Claude history mapper will independently implement a small content classifier inspired by Paseo's behavior. A `user` record remains human only when it has visible text and is not native metadata (`isSynthetic`, `isMeta`, or `toolUseResult`) and its visible text is not entirely composed of known control wrappers.

Known control wrappers for this change are complete `<local-command-stdout>` and `<local-command-caveat>` values plus a Claude command envelope whose `<command-name>` is exactly `/model`. Matching is bounded to complete wrappers or the exact command-name tag; ordinary text mentioning these strings remains visible. Other slash command envelopes remain human because the PRD leaves slash-command interpretation to the Harness and they can represent genuine user prompts.

Alternative: accept only `promptSource === "sdk"`. Rejected because the product must project human Turns added later through the native Claude client, and older native records may not carry that field.

Alternative: discard every `<command-name>` record. Rejected because this would hide genuine slash-command prompts such as `/diagnose`.

### 2. Keep existing-order validation before persistence

`alignSnapshot()` continues to require every persisted Native Turn to appear exactly once and in the same relative order in the latest Snapshot. A missing existing Turn, reordered existing pair, cross-Session identity, or changed Host/Native association still fails before writing.

This is intentionally stricter than Paseo's Timeline hydration because codexhost uses persisted identities for Desktop Turn stability and exact Fork/rollback boundaries.

### 3. Reconcile a complete ordered mapping set atomically

Mapping Store will expose `reconcileTurnMappings(hostThreadId, mappings)`, where `mappings` is the complete order derived from one validated Snapshot. The Store verifies that all current mappings are retained as an ordered subsequence with unchanged Host-to-Native associations, permits new mappings between them, and permits only monotonic Checkpoint enrichment. It then atomically replaces the record's complete `turnMappings` array.

The existing append-oriented `upsertTurnMappings()` remains for live terminal persistence, where a newly completed Turn is necessarily appended. `replaceReadySession()` remains dedicated to post-Fork rollback and its distinct Native Session transition.

A reconciliation equal to the current set is an idempotent no-op. This avoids unnecessary revisions during repeated cold reads.

### 4. Repair existing inconsistent records explicitly

The code change prevents new bad ordering but cannot infer whether an already inconsistent record is safe to rewrite without comparing it to its exact Native Snapshot. No startup migration is added. After deployment, the diagnosed Thread can be repaired with a reviewed one-shot operation that retains Host IDs and orders them by the filtered Snapshot; that operation is outside this implementation change.

## Risks / Trade-offs

- [Claude introduces new local-command wrappers] -> Keep classification centralized and add fixture-derived tests as new structured forms are observed; unknown records remain visible or fail identity validation rather than being broadly dropped.
- [Filtering `/model` could hide a manually typed control action] -> Model selection is control-plane state rather than conversational content; all other slash-command envelopes remain visible.
- [Complete replacement could conceal Native history loss] -> Require the prior mapping sequence to remain a complete ordered subsequence and reject removals or reorderings before durable replacement.
- [Store write fails during reconciliation] -> Reuse existing atomic replacement and index commit behavior so the prior durable and in-memory record remains authoritative.
- [Paseo licensing or ownership differs] -> Reimplement only the observed classification behavior; do not copy source, persistent Timeline, or Provider architecture.

## Migration Plan

1. Ship Adapter classification, ordered reconciliation, and focused tests.
2. Verify repeated cold restore against isolated test Stores and the diagnosed Native history using a copied Store only.
3. Back up and explicitly repair the diagnosed revision only after the fixed binary is in use.
4. Rollback removes the new reconciliation call and classifier changes; records already stored in correct Native Snapshot order remain valid under the previous reader.

## Open Questions

- Which additional Claude local-command wrappers should be classified after real cross-version fixtures are available?
- Should a future maintenance command expose reviewed per-Thread mapping repair, or should repair remain an operator-only migration?
