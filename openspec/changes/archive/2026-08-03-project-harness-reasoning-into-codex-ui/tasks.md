## 1. Implementation Context And Desktop Gate

- [x] 1.1 Rebase the implementation branch onto the then-current mainline, read the current active Pi Slash/Claude Interaction artifacts plus owning specs, source, tests, and Gate records, and report any conflict before production edits.
- [x] 1.2 Generate the supported Desktop's current app-server bindings and run a bounded synthetic Gate for Reasoning content-only, summary-only, and combined start/delta/completion shapes, including eager versus lazy Agent Message ordering.
- [x] 1.3 Record the faithful Codex summary lane, exact initial Item/index shape, stock live-text/duration-only completion behavior, and the lazy external Agent Message projection required for stable ordering.

## 2. Host Contract And Protocol Projection

- [x] 2.1 Add `HostReasoningItem` to the HarnessAdapter `HostItem` union, allow the existing `text.append` update for Agent Message and Reasoning only, and update Fake Adapter/contract exhaustiveness tests without adding capabilities or native fields.
- [x] 2.2 Extend the stateful Codex Turn projector with the Gate-selected summary start/delta/completion mapping, defer empty external Agent Message projection until its first non-empty append, and preserve exact-once final snapshots plus existing Tool, Question, Approval, Usage, and completion behavior.
- [x] 2.3 Extend historical Turn projection for deterministic completed Reasoning Items without live delta replay, Host Runtime branches, Renderer changes, or Mapping Store content.
- [x] 2.4 Add focused Protocol Core tests for live append order, multiple Reasoning Items, completed-text non-replay, deferred and omitted empty Agent Messages, cancellation/failure closure, historical projection, invalid updates, and unchanged official/non-Reasoning, Question, and Approval behavior.
- [x] 2.5 Run the synthetic Desktop Gate through a restarted Fake Host and real `thread/read` path, prove final-answer restoration with no live delta replay, and record that historical Reasoning UI is not required for the live-awareness goal.

## 3. Pi Visible Reasoning

- [x] 3.1 Extend the private Pi RPC Turn event parser for thinking boundaries and deltas, extract complete Assistant thinking text, and reconcile streamed prefixes with final suffixes without exposing Pi payloads.
- [x] 3.2 Add one lazy Reasoning lifecycle per Pi Assistant message in PiAdapter and close active Reasoning through the existing success, cancel, failure, close, and fault finalizers without changing Thinking configuration semantics.
- [x] 3.3 Map active-branch persisted Pi `thinking` blocks into deterministic historical Reasoning Items while preserving existing Turn, Checkpoint, Agent Message, Tool, and File Change identities.
- [x] 3.4 Add focused Pi transport, Adapter, and history tests for delta streaming, final-only content, missing suffix, multiple Assistant messages, conflicting content, empty boundaries, inactive branches, cancellation/fault cleanup, and no derivation from Thinking level or Usage.

## 4. Claude Code Visible Reasoning

- [x] 4.1 Extend the private Claude native-message accumulator to track visible reasoning per native Assistant message, reconcile `thinking_delta` with complete `thinking` blocks, and ignore redacted, signature, encrypted, empty, and unknown blocks.
- [x] 4.2 Extend the private Claude transport event union and Claude Adapter active-Turn state with lazy Reasoning Item lifecycles, exact message correlation, and existing terminal cleanup without adding Thinking selection or ordinary Tool projection.
- [x] 4.3 Map supported historical Claude `thinking` blocks into deterministic Reasoning Items while retaining caller User UUID Turn identity, unknown historical outcome, and the existing official history API boundary.
- [x] 4.4 Add focused Claude accumulator, transport, Adapter, and history tests for partial/full agreement, final-only content, multiple Assistant messages, conflict failure, redacted/unknown omission, cancellation/fault closure, repeated Snapshot identity, and no duplicate output.

## 5. Validation And Baseline Updates

- [x] 5.1 Run affected HarnessAdapter, Protocol Core, Pi, Claude, Host integration, history, and projection tests plus affected typecheck, lint, build, and diff checks; audit that no Reasoning content enters Mapping Store, diagnostics, fixtures, or committed evidence.
- [x] 5.2 Run a controlled real Pi/Desktop Gate proving live visible Reasoning, correct order relative to Tools and final text, stock duration-only same-session completion, a Turn with no thinking, Thread reopen of the final answer, and unchanged same-Session continuation.
- [x] 5.3 Run an explicitly authorized bounded Claude SDK/Desktop Gate proving partial or final live visible thinking, no duplicate completion, final answer separation, cancellation/failure cleanup, and Native history reopen of the final answer; record quota/network or development-route blockers instead of claiming unrun coverage.
- [x] 5.4 Run an official Codex passthrough regression and verify that no custom Renderer, shared browser contract, Host routing method, capability catalog, or persistent format was introduced.
- [x] 5.5 Update affected architecture/checklist and verification records only with completed behavior and real Gate evidence, then run `openspec validate project-harness-reasoning-into-codex-ui --strict` and `git diff --check`.
