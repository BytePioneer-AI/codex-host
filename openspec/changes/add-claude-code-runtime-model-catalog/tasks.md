## 1. Shared Model Contracts

- [ ] 1.1 Extend browser-safe Model Catalog, Session selection state, and Thread inspection schemas with optional bounded display-only `resolvedModelLabel`
- [ ] 1.2 Preserve strict opaque Ref-only Model control params and reject resolved labels, native metadata, and undeclared fields at every public parse boundary
- [ ] 1.3 Update HarnessAdapter/Fake Harness types and fixtures for selectable effective Ref plus runtime-resolved display without changing Pi semantics
- [ ] 1.4 Add Shared Contracts and HarnessAdapter tests for aliases sharing one resolved Model, dynamic default resolution, malformed labels, and JSON round-trip

## 2. Claude SDK Catalog Transport

- [ ] 2.1 Add private Claude ModelInfo/current-Model runtime schemas and canonical `claude-model-v1` Ref encode/decode helpers owned only by the Claude Adapter package
- [ ] 2.2 Normalize SDK selectable values, default sentinel, distinguishable duplicate display labels, optional resolved metadata, and effort capability metadata without parsing descriptions
- [ ] 2.3 Add a no-Prompt temporary SDK Query path that uses production cwd/environment/setting sources, reads initialization Models and stable `getContextUsage().model`, and never submits a User message
- [ ] 2.4 Own temporary Claude child processes through successful, malformed, timeout, startup-error, refresh, and Adapter-close paths and wait for bounded exit before inspection resolves
- [ ] 2.5 Add normalized-cwd in-memory success caching, per-cwd in-flight coalescing, explicit refresh replacement, and failure non-caching
- [ ] 2.6 Feature-detect missing/older SDK Model operations and return ready empty Catalog with selection disabled instead of guessing from CLI versions or local settings
- [ ] 2.7 Add Hermetic transport/normalization tests for first-party rows, custom gateway rows, aliases, default, absent `resolvedModel`, malformed payloads, privacy rejection, caching, and cleanup

## 3. Claude Session Model Control

- [ ] 3.1 Allow lazy Claude create Sessions to retain an optional owned Model Ref while continuing to reject any Claude Thinking selection
- [ ] 3.2 Initialize the first long-lived Query with the exact decoded selectable value, or no explicit override for default, without starting a process during unused create/resume
- [ ] 3.3 Read stable actual Model state after Query initialization and publish Native Ref, effective selectable Ref, and `resolvedModelLabel` before the first `turn.started`
- [ ] 3.4 Implement Idle-only `model.select` with the official setter, default reset, stable actual-Model readback, complete ordered state publication, and command completion after state observation
- [ ] 3.5 Serialize Model configuration against Turn acceptance, active/cancelling/settling Turns, history reads, close, and other configuration writes
- [ ] 3.6 Preserve prior state on definite setter rejection and fault the Session when a possible write cannot be resolved by valid actual-Model readback
- [ ] 3.7 Restore resumed Claude Model state from the started Native Query/readback without persisting or inferring a second Catalog
- [ ] 3.8 Add Claude Adapter tests for default, concrete value, alias-to-custom resolution, first-Turn ordering, Idle selection, reset, busy races, rejection, uncertain write, resume, and bounded close

## 4. Protocol And Host Routing

- [ ] 4.1 Add bounded `codexhost/claude-code-native@<opaque-ref>` encode/decode while preserving the generic Claude carrier, Pi carrier formats, and official Codex transparency
- [ ] 4.2 Reject malformed, oversized, empty-component, extra-component, and foreign-Harness Claude carriers without falling through to Codex
- [ ] 4.3 Pass each create-scoped Claude Ref only to that exact `Adapter.open(create)` and keep concurrent Composer selections isolated
- [ ] 4.4 Reuse generic registered-Harness inspect, model-select, state revision, Thread inspection, and existing-Turn carrier verification without Claude SDK parsing or Harness-specific Host branches
- [ ] 4.5 Project optional resolved Model display through fixed Host responses while keeping Mapping Store, Native Ref, Usage, title, and official request paths unchanged
- [ ] 4.6 Add Protocol and Host tests for generic/default/selected Claude creates, concurrent creates, Existing Thread selection, ordered readback, stale/foreign carriers, disabled capability, fault, and no fallback

## 5. Capability-Driven Renderer Model UI

- [ ] 5.1 Generalize Pi-named Model client/view/Composer state internals to external Harness Model state while preserving fixed request methods and public compatibility where required
- [ ] 5.2 Inspect the currently selected external Harness, generation-scope each Catalog request, and keep Claude/Pi caches and selected Refs isolated per logical Composer
- [ ] 5.3 Encode Claude draft Model selection into the same optimistic Model atom before stale official prewarm clearing and freeze the exact Ref at submission
- [ ] 5.4 Restore Claude draft replacement/revisit state, reset Model on a new default Composer, and preserve Codex opaque official Model restoration
- [ ] 5.5 Route Existing Claude Thread selection through fixed Host controls and apply only confirmed effective Ref plus resolved Model label
- [ ] 5.6 Render normalized Claude Model/default/alias labels and compact resolved Model information without exposing transport carriers, opaque Refs, raw SDK descriptions, or a Claude Thinking selector
- [ ] 5.7 Keep submission and controls fail-closed for unresolved/malformed Catalogs, ambiguous ownership, missing request manager, in-flight selection, and Session faults
- [ ] 5.8 Add Renderer state, client, carrier, picker, DOM, stale generation, Composer lifecycle, Codex restoration, and Pi regression tests

## 6. Gates, Documentation, And Completion

- [ ] 6.1 Extend the explicit Claude inspect Gate to record only SDK/CLI compatibility, Catalog shape/count classes, alias/default/custom relationships, actual-Model readback, zero Native Sessions, and owned process exit
- [ ] 6.2 Add an explicit quota-using Claude live Model Gate that requires two genuinely different callable actual Models or reports environment BLOCKED without recording Model names, Prompt, content, account, paths, or complete IDs
- [ ] 6.3 Extend controlled Host/Desktop Gates for Claude Catalog display, selected draft create, Existing Thread switch, default reset, resolved display, Codex/Pi isolation, and privacy
- [ ] 6.4 Update affected architecture/provider guidance and `docs/开发步骤清单.md` status without claiming unexecuted real, Windows, custom-gateway, or Desktop evidence
- [ ] 6.5 Run focused package tests, formatting, ESLint/boundary checks, typecheck, TypeScript/Renderer build, and `git diff --check`
- [ ] 6.6 Run `openspec validate add-claude-code-runtime-model-catalog --strict` and record executed Gate results plus remaining BLOCKED platform/environment evidence in a reviewed verification document
