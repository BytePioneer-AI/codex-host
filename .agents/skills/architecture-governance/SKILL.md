---
name: architecture-governance
description: Apply codexhost package and native ownership rules when changing production code or dependency directions. Inspect public contracts and run the existing boundary check; skip documentation-only work.
---

<!-- Adapted for codexhost from ZCode 872ad960de7ec172591f7e1952f7849229f94521. See ../NOTICE.md for provenance and licenses. -->

# Architecture governance

Use the current repository's [AGENTS.md](../../../AGENTS.md) and executable [boundary checker](../../../tools/check-boundaries.mjs) as the policy. Paths in commands are relative to the repository root.

## Before changing code

1. Inspect the working tree and identify the owning package or crate. Preserve unrelated edits. Read the relevant package exports, contracts, implementation, tests, and feature documentation; use [docs/index.md](../../../docs/index.md) to locate it.
2. For dependency changes, read `tools/check-boundaries.mjs` and run `node tools/check-boundaries.mjs` before editing to establish the current result. This checker scans the repository; it has no `--changed` mode or suppressible baseline.
3. For changes to state, asynchronous behavior, or cross-package contracts, identify the authoritative owner, command path, derived views, event order, failure semantics, and native capability limits. Use [implementation questions](references/ai-guidance.md) when needed.
4. Record substantial behavior or architecture decisions in the relevant existing feature document. Follow AGENTS.md for documentation scope; small fixes do not require a new spec or module scaffold.

## Implement within existing ownership

Use package public exports for cross-package dependencies. Preserve the Rust, Renderer, Shared Contracts, Host, and Harness Adapter responsibilities from AGENTS.md. Put Harness-specific protocols in the corresponding Adapter and load installed Harnesses through the plugin contract.

Use [public contract guidance](references/module-contract.md) when an interface must change. New modules should solve a present responsibility; do not introduce ZCode's module manifests, layer names, or policy files into this repository merely to follow its original workflow.

## Verify

Run `node tools/check-boundaries.mjs` after production changes that affect boundaries. Select other validation from the actual package scripts and owning test configuration, proportional to the change. Run focused behavior tests for changed semantics; a boundary check alone does not prove runtime correctness.

Report new failures separately from pre-existing failures, and state what was actually executed. A skipped or unavailable check remains unverified. Use the current script output as evidence; do not claim detection of cycles, line-count thresholds, or state ownership unless an executed check actually covers them.
