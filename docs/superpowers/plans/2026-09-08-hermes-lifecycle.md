# Hermes Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hermes model selection, creation failures, cancellation state, warm creation, and release packaging correct and verifiable in CodexHost.

**Architecture:** Keep Hermes protocol semantics inside `adapter-hermes`, keep cross-Harness thread state in `host-runtime`, and keep DOM reconciliation in `renderer-extension`. Reuse one ACP process per Hermes Adapter while routing session-scoped prompt state by native session ID.

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

- [ ] **Step 1: Add a failing inventory test**

  Add a fixture where the probe reports configured provider `zai` and model `glm-5-turbo`; assert the catalog default ref decodes to `zai:glm-5-turbo`. Add a fixture with no current model and assert `defaultModel === null`.

- [ ] **Step 2: Run the inventory test and confirm RED**

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test/hermes-inventory.test.ts`

  Expected: the configured-default assertion fails because `currentModelId` is null, and the no-current assertion fails because the first row is selected.

- [ ] **Step 3: Implement truthful inventory projection**

  Extend `INVENTORY_PROBE_SCRIPT` to emit current provider/model from `load_picker_context()`, parse the values in `runProbe()`, build the canonical `<provider>:<model>` ID, and remove the first-row fallback from `catalogModelsFromInventory()`.

- [ ] **Step 4: Add a failing native-detail error test**

  Feed an ACP rejection shaped as `{ message: "Internal error", data: { details: "provider is not configured" } }`; assert the Harness error contains `provider is not configured` and retains the authentication/unavailable classification.

- [ ] **Step 5: Run the error test and confirm RED**

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test/hermes-adapter.test.ts`

  Expected: failure message remains the generic ACP message.

- [ ] **Step 6: Implement native error extraction and verify GREEN**

  Add a narrow `errorDetails()` normalizer in `acp-transport.ts`, use it in `classifyStartupError()`, then rerun both focused test files.

### Task 2: Transactional Hermes creation cleanup

**Files:**
- Modify: `packages/adapters/hermes/src/acp-transport.ts`
- Modify: `packages/adapters/hermes/src/hermes-adapter.ts`
- Test: `packages/adapters/hermes/test/hermes-adapter.test.ts`

**Interfaces:**
- Consumes: the native session ID returned by `HermesAcpTransport.open({kind:"create"})`.
- Produces: `HermesAcpTransport.deleteSession(sessionId): Promise<void>` and best-effort rollback in `HermesAdapter.open()`.

- [ ] **Step 1: Add a failing rollback behavior test**

  Simulate successful `session/new`, failing `session/set_model`, and a successful native delete response. Assert the adapter returns the original model error, invokes native deletion for exactly the newly created session, and closes the transport. Add a resume failure case asserting no deletion.

- [ ] **Step 2: Run the rollback test and confirm RED**

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test/hermes-adapter.test.ts`

  Expected: no native deletion request is observed.

- [ ] **Step 3: Implement best-effort create rollback**

  Add `deleteSession()` using the Hermes-supported session deletion command/boundary exposed by the ACP connection. Track the created native ID in `HermesAdapter.open()` and call deletion only for failed create transactions; attach cleanup failure to diagnostics without replacing the primary error.

- [ ] **Step 4: Run focused Adapter tests and confirm GREEN**

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test/hermes-adapter.test.ts`

### Task 3: Cancellation terminal-state convergence

**Files:**
- Modify: `packages/host-runtime/src/app-server-host.ts`
- Modify: `packages/renderer-extension/src/renderer-binding-probe.ts`
- Test: `packages/host-runtime/test/app-server-host.test.ts`
- Test: `packages/renderer-extension/test/renderer-binding-probe.test.ts`

**Interfaces:**
- Consumes: `turn.completed` with outcome `cancelled` and `thread/status/changed`.
- Produces: exactly one externally visible terminal turn and an eventually-idle thread/sidebar state.

- [ ] **Step 1: Add a failing Host cancellation test**

  Drive a real fake HarnessSession through turn start, cancel acceptance, and `turn.completed(cancelled)`. Assert Host state reports `running=false`, `activeTurnId=null`, and publishes an idle `thread/status/changed` even if the terminal turn projection writer rejects once.

- [ ] **Step 2: Run the Host test and confirm RED**

  Run: `npx vitest run --config tests/vitest.config.js packages/host-runtime/test/app-server-host.test.ts -t "cancelled external turn converges to idle"`

  Expected: idle status is absent or skipped after the injected projection failure.

- [ ] **Step 3: Implement idempotent Host finalization**

  Extract the non-ephemeral terminal state mutation and idle publication into a focused private finalization path. Clear in-memory running state before writes and publish idle in `finally`; preserve subagent-active status when applicable.

- [ ] **Step 4: Add a failing Renderer reconciliation test**

  Simulate an external terminal turn arriving before a delayed/stale active status. Assert the local ownership/running marker is cleared and the sidebar is not left with the running indicator.

- [ ] **Step 5: Run the Renderer test and confirm RED**

  Run: `npx vitest run --config tests/vitest.config.js packages/renderer-extension/test/renderer-binding-probe.test.ts -t "terminal external turn clears running state"`

- [ ] **Step 6: Implement terminal reconciliation and verify GREEN**

  Update the renderer binding's notification reducer so terminal turn and idle status both clear external running state, while a stale active notification cannot resurrect a completed turn. Rerun both focused files.

### Task 4: Reuse the Hermes ACP process

**Files:**
- Create: `packages/adapters/hermes/src/acp-process-client.ts`
- Modify: `packages/adapters/hermes/src/acp-transport.ts`
- Modify: `packages/adapters/hermes/src/hermes-adapter.ts`
- Test: `packages/adapters/hermes/test/hermes-adapter.test.ts`
- Test: `packages/adapters/hermes/test/hermes-acp-process-client.test.ts`

**Interfaces:**
- Consumes: ACP initialize/session methods plus session-scoped update callbacks.
- Produces: `HermesAcpProcessClient` with `openSession`, `prompt`, `cancel`, `setModel`, `deleteSession`, and reference-counted `closeSession`; `HermesAdapter.close()` owns final process shutdown.

- [ ] **Step 1: Add a failing warm-process lifecycle test**

  Open two sequential Hermes create sessions through one Adapter; close the first; assert only one child ACP process is spawned, the second session has a distinct native ID, and Adapter close terminates the process once.

- [ ] **Step 2: Run the lifecycle test and confirm RED**

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test/hermes-acp-process-client.test.ts`

  Expected: the second open spawns another process.

- [ ] **Step 3: Implement session-multiplexed process ownership**

  Move child/connection lifecycle into `HermesAcpProcessClient`. Store active prompt handlers in `Map<sessionId, ActivePrompt>`; route ACP updates and permission requests by native session ID; reject concurrent prompts only within the same session. Make per-session transport close release callbacks without killing the shared process.

- [ ] **Step 4: Adapt HermesAdapter ownership**

  Lazily create one process client per Adapter/cwd-compatible scope, have session transports borrow it, and close it from `HermesAdapter.close()`. Keep import probes isolated so they cannot disturb active chat sessions.

- [ ] **Step 5: Run all Hermes tests and confirm GREEN**

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test`

- [ ] **Step 6: Measure cold and warm creation**

  Run the installed plugin probe for one cold default open, one warm default open, and one warm explicitly selected model open. Record milliseconds and compare process spawn counts. Success requires warm open to remove one ACP process startup; selected-model native rebuild time is reported separately.

### Task 5: Release integration and complete verification

**Files:**
- Modify: `scripts/release/harness-plugins.json`
- Modify: `packages/host-runtime/test/hermes-plugin-loader.real.test.ts`
- Modify only if required by current contracts: affected renderer binding test fixtures.

**Interfaces:**
- Consumes: `@codexhost/adapter-hermes` plugin package.
- Produces: a preinstalled Hermes plugin artifact loadable by Host Runtime.

- [ ] **Step 1: Add the Hermes plugin to the release manifest**

  Add the workspace package, manifest, plugin entry, and asset mapping using the same schema as other preinstalled Harness plugins.

- [ ] **Step 2: Repair the real loader test against the current registry API**

  Exercise the built Hermes plugin through the public installed-plugin loader and assert Harness id `hermes`, ready/error inspection shape, and public factory availability without calling removed `registry.get` APIs.

- [ ] **Step 3: Run focused release and loader validation**

  Run: `npm run build:plugins`

  Run: `npx vitest run --config tests/vitest.config.js packages/host-runtime/test/hermes-plugin-loader.real.test.ts packages/host-runtime/test/installed-harness-plugins.test.ts`

- [ ] **Step 4: Run package-level validation**

  Run: `npm run typecheck`

  Run: `npm run lint`

  Run: `npx vitest run --config tests/vitest.config.js packages/adapters/hermes/test packages/host-runtime/test/app-server-host.test.ts packages/renderer-extension/test/renderer-binding-probe.test.ts packages/renderer-extension/test/renderer-model-picker.test.ts`

- [ ] **Step 5: Build and install the verified artifacts**

  Build the Hermes plugin and renderer extension, preserve timestamped backups of currently installed artifacts, copy the new outputs into `/Applications/codexhost.app` and `~/.codexhost/plugins/hermes`, then restart CodexHost only after builds and focused tests pass.

- [ ] **Step 6: Perform installed-app acceptance**

  Verify in the installed app: actual configured default label, selected model persistence, detailed create error, stop clearing both main pane and sidebar, and measured second-thread creation. Capture any behavior that still belongs to Hermes native startup rather than claiming it fixed.

