# Hermes Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hermes model selection, creation failures, cancellation state, warm creation, and release packaging correct and verifiable in CodexHost.

**Architecture:** Keep Hermes protocol semantics inside `adapter-hermes` and cross-Harness thread state in `host-runtime`. Keep one initialized spare transport per cwd while preserving one process per active Hermes Session.

**Tech Stack:** TypeScript 6, Vitest 4, Agent Client Protocol SDK 1.3, Electron renderer extension, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-08-hermes-lifecycle-design.md`

## Global Constraints

- Do not install or repair MiniMax-M3 dependencies.
- Do not modify Hermes source or `~/.hermes/state.db`.
- Do not delete existing historical sessions.
- Preserve Harness-specific semantics inside `packages/adapters/hermes`.
- Use failing behavior tests before production changes.
- Do not alter unrelated dirty renderer files or the untracked duplicate `versioned-renderer-adapter 2.ts`.

---

### Task 1: Truthful Hermes catalog and actionable ACP errors

**Files:**
- Modify: `packages/adapters/hermes/src/hermes-inventory.ts`
- Modify: `packages/adapters/hermes/src/acp-transport.ts`
- Test: `packages/adapters/hermes/test/hermes-inventory.test.ts`
- Test: `packages/adapters/hermes/test/hermes-adapter.test.ts`

**Interfaces:**
- Consumes: Hermes inventory `provider` and `model` configuration plus JSON-RPC error objects.
- Produces: `HermesInventory.currentModelId` and `HermesTransportError.message` containing the most actionable native detail.

- [x] **Step 1: Add a failing inventory test**

  Add a fixture where the probe reports configured provider `zai` and model `glm-5-turbo`; assert the catalog default ref decodes to `zai:glm-5-turbo`. Add a fixture with no current model and assert `defaultModel === null`.

- [x] **Step 2: Run the inventory test and confirm RED**

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test/hermes-inventory.test.ts`

  Expected: the configured-default assertion fails because `currentModelId` is null, and the no-current assertion fails because the first row is selected.

- [x] **Step 3: Implement truthful inventory projection**

  Extend `INVENTORY_PROBE_SCRIPT` to emit current provider/model from `load_picker_context()`, parse the values in `runProbe()`, build the canonical `<provider>:<model>` ID, and remove the first-row fallback from `catalogModelsFromInventory()`.

- [x] **Step 4: Add a failing native-detail error test**

  Feed an ACP rejection shaped as `{ message: "Internal error", data: { details: "provider is not configured" } }`; assert the Harness error contains `provider is not configured` and retains the authentication/unavailable classification.

- [x] **Step 5: Run the error test and confirm RED**

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test/hermes-adapter.test.ts`

  Expected: failure message remains the generic ACP message.

- [x] **Step 6: Implement native error extraction and verify GREEN**

  Add a narrow `errorDetails()` normalizer in `acp-transport.ts`, use it in `classifyStartupError()`, then rerun both focused test files.

### Task 2: Confirm the safe creation rollback boundary

- [x] Confirmed Host provisional mappings are removed when Adapter open fails.
- [x] Confirmed Hermes ACP does not expose a session deletion method.
- [x] Kept the safe boundary: close failed transport; do not mutate `~/.hermes/state.db` or call private Hermes helpers.
- [x] Documented that a native empty session may remain when `session/new` succeeds but later configuration fails.

### Task 3: Cancellation terminal-state convergence

**Files:**
- Modify: `packages/host-runtime/src/app-server-host.ts`
- Test: `packages/host-runtime/test/app-server-host.test.ts`

**Interfaces:**
- Consumes: `turn.completed` with outcome `cancelled` and `thread/status/changed`.
- Produces: exactly one externally visible terminal turn and an eventually-idle thread/sidebar state.

- [x] **Step 1: Add a failing Host cancellation-order test**

  Drive a real fake HarnessSession through turn start, cancel acceptance, and `turn.completed(cancelled)`. Assert Host state reports `running=false`, `activeTurnId=null`, and publishes an idle `thread/status/changed` even if the terminal turn projection writer rejects once.

- [x] **Step 2: Run the Host test and confirm RED**

  Run: `npx vitest run --config tests/vitest.config.js packages/host-runtime/test/app-server-host.test.ts -t "cancelled external turn converges to idle"`

  Expected: idle status is absent or skipped after the injected projection failure.

- [x] **Step 3: Match native app-server finalization order**

  Publish idle state before terminal `turn/completed`, matching Codex app-server's lifecycle. The sidebar is native Desktop state, so no Hermes-specific Renderer state machine is added.

### Task 4: Prewarm an isolated Hermes ACP process

- [x] **Step 1: Add a failing prewarm lifecycle test**

  Open two sequential sessions, assert a spare process is created after each open, assert distinct native IDs, and prove the second open consumes the spare instead of spawning synchronously.

- [x] **Step 2: Implement cwd-scoped spare transport ownership**

  Reuse the initialized transport retained by inspect/open, then asynchronously replenish one spare. Active sessions remain process-isolated.

- [x] **Step 3: Skip redundant same-model rebuild**

  When `session/new` already reports the requested model as active, do not call `session/set_model`.

- [x] **Step 4: Run all Hermes tests and confirm GREEN**

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test`

- [ ] **Step 5: Measure installed-app cold and warm creation**

  Complete after the App reloads the installed artifacts. Automated tests prove process reuse; final perceived timing still needs Desktop observation.

### Task 5: Release integration and complete verification

**Files:**
- Modify: `scripts/release/harness-plugins.json`
- Modify: `packages/host-runtime/test/hermes-plugin-loader.real.test.ts`
- Modify only if required by current contracts: affected renderer binding test fixtures.

**Interfaces:**
- Consumes: `@codexhost/adapter-hermes` plugin package.
- Produces: a preinstalled Hermes plugin artifact loadable by Host Runtime.

- [x] **Step 1: Add the Hermes plugin to the release manifest**

  Add the workspace package, manifest, plugin entry, and asset mapping using the same schema as other preinstalled Harness plugins.

- [x] **Step 2: Repair the real loader test against the current registry API**

  Exercise the built Hermes plugin through the public installed-plugin loader and assert Harness id `hermes`, ready/error inspection shape, and public factory availability without calling removed `registry.get` APIs.

- [x] **Step 3: Run focused release and loader validation**

  Run: `npm run build:plugins`

  Run: `npx vitest run --config tests/vitest.config.js packages/host-runtime/test/hermes-plugin-loader.real.test.ts packages/host-runtime/test/installed-harness-plugins.test.ts`

- [x] **Step 4: Run package-level validation**

  Run: `npm run typecheck`

  Run: `npm run lint`

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test packages/host-runtime/test/app-server-host.test.ts packages/renderer-extension/test/renderer-binding-probe.test.ts packages/renderer-extension/test/renderer-model-picker.test.ts`

- [ ] **Step 5: Build and install the verified artifacts**

  Build the Hermes plugin and renderer extension, preserve timestamped backups of currently installed artifacts, copy the new outputs into `/Applications/codexhost.app` and `~/.codexhost/plugins/hermes`, then restart CodexHost only after builds and focused tests pass.

- [ ] **Step 6: Perform installed-app acceptance**

  Verify in the installed app: actual configured default label, selected model persistence, detailed create error, stop clearing both main pane and sidebar, and measured second-thread creation. Capture any behavior that still belongs to Hermes native startup rather than claiming it fixed.
