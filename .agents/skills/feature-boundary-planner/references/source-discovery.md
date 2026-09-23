# Current source discovery

Adapted for codexhost from ZCode; see [provenance](../../NOTICE.md). Paths in this table are repository-relative starting points. Verify behavior against the current checkout.

| Concern | Starting points |
| --- | --- |
| Terminology and feature documents | `docs/project/领域术语表.md`, `docs/index.md` |
| Desktop UI and bindings | `packages/renderer-extension/src`, `packages/desktop-control/src` |
| Host composition and lifecycle | `packages/host-runtime/src` |
| Public Harness contracts and capabilities | `packages/harness-adapter/src`, `packages/shared-contracts/src` |
| Native Harness behavior | `packages/adapters`, `docs/harnesses` |
| Protocol routing and UI projection | `packages/protocol-core/src` |
| Thread and native identity persistence | `packages/mapping-store/src` |
| Remote integration | `docs/platforms/remote`, Host remote modules, `packages/harness-broker/src` |
| Native process/platform ownership | `crates/launcher`, `crates/shim`, `crates/platform`, `crates/updater` |
| Plugin distribution and dependencies | `scripts/release/harness-plugins.json`, package exports, `tools/check-boundaries.mjs` |
| Test entrypoints | Root and package scripts, `tests/vitest.config.js`, `tests/e2e/playwright.config.js`, owning Cargo manifests |

Start with `rg --files` in the owning paths and targeted `rg -n` searches for the user's behavior. Read callers and handlers, not only declarations. There is no maintained ZCode feature graph or `pnpm architecture:context` command in this repository.

For each affected state, identify who accepts writes, who projects it, where it persists, what happens after reconnect, and what evidence proves the behavior. Use supported native capabilities as constraints; an existing button or enum does not establish native functionality.
