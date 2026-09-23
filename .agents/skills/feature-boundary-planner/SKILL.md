---
name: feature-boundary-planner
description: Trace a codexhost feature change across UI surfaces, Host routing, Harness capabilities, state ownership, persistence, and validation. Use for impact analysis, design planning, or implementation handoff.
---

<!-- Adapted for codexhost from ZCode 872ad960de7ec172591f7e1952f7849229f94521. See ../NOTICE.md for provenance and licenses. -->

# Feature boundary planner

Choose the scope implied by the request: **impact-only** reads and reports; **planning** establishes behavior and acceptance cases; **implementation-handoff** identifies concrete code and validation work. Respect existing user decisions and preserve unrelated work.

## Trace the current implementation

1. Use [source discovery](references/source-discovery.md) and the repository documentation index to locate the relevant current contracts and entrypoints. Verify paths and symbols in this checkout.
2. Classify the change as presentation, option source, draft/default, validation, command effect, persistence, or recovery.
3. Trace each affected surface to its authoritative owner: Renderer/Desktop binding → Host request routing → Adapter/native operation → confirmed event → projection. Some features end earlier; follow only the relevant path.
4. Use `$dep-refs` for callers and re-exports. Imports alone do not prove a product dependency. Start with direct relationships, expanding when ownership or a caller remains unresolved.
5. Distinguish official Codex Threads from external Harness Threads; local and remote Hosts; Native Session facts from Host metadata; capabilities from UI affordances. Use the repository terminology.

For stateful changes, show the event order and owner in a concise diagram. Identify cancellation, duplicate input, stale results, reconnect and recovery where they can affect behavior.

## Plan and validate

In impact-only mode, report findings without changing implementation or specifications. In planning modes, maintain the relevant feature document for substantial behavior changes as required by AGENTS.md. Minor changes do not need a new documentation hierarchy.

Select representative high-risk cases rather than every combination of Harness, platform and state. Classify cases as accepted, undefined, pruned, ignored, or bug-candidate, giving evidence for exclusions. Use [case planning](references/case-planning-template.md) for complex changes and [impact brief](references/impact-brief-template.md) for a structured handoff; fill only useful sections.

Inspect actual test files and package scripts before recommending commands. Distinguish planned coverage, existing tests, executed checks and runtime evidence. Missing source or a planned independent-client feature is not evidence of current capability.

Complete with the affected surfaces, owners, contracts, verified code references, native capability constraints, required checks and unresolved decisions. Ask only for decisions that cannot be resolved from authorized scope or current evidence.
