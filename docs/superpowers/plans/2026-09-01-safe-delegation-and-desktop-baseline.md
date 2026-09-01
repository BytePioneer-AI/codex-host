# Safe Delegation and Desktop Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make delegation approval-first, make delegation Skill installation explicit and reversible, and gate Codex Desktop compatibility against reviewed identities.

**Architecture:** Extend the typed Harness execution policy through the existing CLI, Runtime, broker, coordinator, and adapter boundaries. Keep Skill lifecycle logic in `host-runtime`, reuse the existing launcher-to-Node CLI bridge, and layer an exact-identity manifest plus strict wrapper over the existing Desktop contract audit.

**Tech Stack:** TypeScript 6, Node.js 22/24, Vitest 4, Zod 4, Rust 1.97.1 launcher, Electron Inspector/CDP contract audit.

## Global Constraints

- Node.js must remain `>=22.19.0 <23.0.0 || >=24.0.0 <25.0.0`; npm remains `11.8.0`.
- Rust remains pinned to `1.97.1`; do not add dependencies.
- Delegation defaults to `approval-required`; unattended access requires an explicit caller value.
- Pi must reject approval-required delegation until a real approval bridge exists.
- Host startup must not write `~/.agents` or `~/.claude`.
- Skill uninstall must preserve unknown or modified files.
- The first reviewed Desktop identity is macOS `26.825.41651`, build `7345`, `sha256:c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d`.
- New Desktop identities are accepted only by an explicit command using a reviewed audit report.
- Follow `AGENTS.md` boundaries: Rust owns native launcher routing; TypeScript owns Harness, delegation, Skill, and audit semantics.

---

### Task 1: Extend the Shared Execution Policy Contract

**Files:**
- Modify: `packages/harness-adapter/src/text-session.ts:67`
- Modify: `packages/harness-adapter/test/index.test.ts:12-17`
- Modify: `packages/harness-broker/src/validation.ts:19-29`
- Modify: `packages/harness-broker/test/harness-broker.test.ts`
- Modify: `packages/adapters/opencode/src/history.ts:55-65`
- Modify: `packages/adapters/opencode/test/history.test.ts`

**Interfaces:**
- Produces: `HarnessExecutionPolicy = "default" | "approval-required" | "unattended-full-access"`.
- Produces: broker and persisted OpenCode session schemas that accept the same three values.
- Consumes: existing `CreateSessionInput.executionPolicy?: HarnessExecutionPolicy`.

- [ ] **Step 1: Write failing contract tests**

Add a runtime broker assertion and extend the compile-time package assertion:

```ts
it("accepts the approval-required create policy", () => {
  expect(
    brokerOpenInputSchema.parse({
      kind: "create",
      cwd: "/workspace",
      executionPolicy: "approval-required",
    }),
  ).toMatchObject({ executionPolicy: "approval-required" });
});

it("exports the approval-required execution policy", () => {
  const policy: HarnessExecutionPolicy = "approval-required";
  expect(policy).toBe("approval-required");
});
```

Add an OpenCode history test that round-trips a native session locator containing `executionPolicy: "approval-required"`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm run build:typescript && npx vitest run packages/harness-adapter/test/index.test.ts packages/harness-broker/test/harness-broker.test.ts packages/adapters/opencode/test/history.test.ts --config tests/vitest.config.js
```

Expected: TypeScript rejects `"approval-required"` and/or Zod reports an invalid enum value.

- [ ] **Step 3: Add the policy value to all three owning schemas**

Use one exact union everywhere:

```ts
export type HarnessExecutionPolicy =
  | "default"
  | "approval-required"
  | "unattended-full-access";
```

Update the two Zod enums to include `"approval-required"`; do not introduce a second policy type.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all selected files pass.

- [ ] **Step 5: Commit the shared contract**

```bash
git add packages/harness-adapter packages/harness-broker packages/adapters/opencode/src/history.ts packages/adapters/opencode/test/history.test.ts
git commit -m "feat: add approval-required execution policy"
```

---

### Task 2: Default Delegation Requests to Approval-Required

**Files:**
- Modify: `packages/host-runtime/src/delegation-types.ts:48-75`
- Modify: `packages/host-runtime/src/delegation-cli.ts:65-245`
- Modify: `packages/host-runtime/src/harness-delegation-coordinator.ts:58-70,192-310`
- Modify: `packages/host-runtime/test/delegation-cli.test.ts`
- Modify: `packages/host-runtime/test/harness-delegation-coordinator.test.ts`

**Interfaces:**
- Produces: `DelegationExecutionPolicy = Exclude<HarnessExecutionPolicy, "default">`.
- Produces: `DelegationStartInput.executionPolicy?: DelegationExecutionPolicy`.
- Produces: `codexhost delegate start ... --execution-policy approval-required|unattended-full-access`.
- Consumes: Task 1 `HarnessExecutionPolicy`.

- [ ] **Step 1: Write failing CLI and coordinator tests**

Change the existing coordinator expectation from unattended to approval-required and add an explicit override test:

```ts
expect(adapter.openInputs[0]).toMatchObject({
  kind: "create",
  executionPolicy: "approval-required",
});

await value.coordinator.start({
  harnessId: "claude-code",
  task: "trusted automation",
  cwd: "/synthetic",
  parentThreadId: "parent-thread",
  executionPolicy: "unattended-full-access",
});
expect(adapter.openInputs.at(-1)).toMatchObject({
  executionPolicy: "unattended-full-access",
});
```

Extend the CLI payload test:

```ts
arguments: [
  "delegate",
  "start",
  "--harness",
  "claude-code",
  "--task",
  "review auth",
  "--execution-policy",
  "unattended-full-access",
],
```

Assert omitted CLI input sends `executionPolicy: "approval-required"`. Add a request-id test proving the same request ID cannot be reused with a different execution policy.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm run build:typescript && npx vitest run packages/host-runtime/test/delegation-cli.test.ts packages/host-runtime/test/harness-delegation-coordinator.test.ts --config tests/vitest.config.js
```

Expected: the coordinator still records unattended access, and the CLI rejects `--execution-policy` as unknown.

- [ ] **Step 3: Add typed request parsing and normalization**

Define the delegation-only type and field:

```ts
export type DelegationExecutionPolicy = Exclude<HarnessExecutionPolicy, "default">;

export interface DelegationStartInput {
  harnessId: RoutedHarnessId;
  task: string;
  cwd: string;
  executionPolicy?: DelegationExecutionPolicy;
  parentThreadId?: string;
  requestId?: string;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
}
```

Parse only the two delegation values. Put the normalized value in the Runtime JSON body even when the option is omitted:

```ts
const executionPolicy = value(parsed, "--execution-policy") ?? "approval-required";
if (![
  "approval-required",
  "unattended-full-access",
].includes(executionPolicy)) {
  throw new DelegationControlError(
    "INVALID_ARGUMENT",
    "--execution-policy must be approval-required or unattended-full-access",
  );
}
```

- [ ] **Step 4: Normalize once in the coordinator and include policy in deduplication**

```ts
const executionPolicy = input.executionPolicy ?? "approval-required";
```

Add the normalized policy to `taskDigest`, pass it to `adapter.open`, and include it in the returned delegation configuration. Do not default inside each caller independently.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: both test files pass.

- [ ] **Step 6: Commit delegation request wiring**

```bash
git add packages/host-runtime/src/delegation-types.ts packages/host-runtime/src/delegation-cli.ts packages/host-runtime/src/harness-delegation-coordinator.ts packages/host-runtime/test/delegation-cli.test.ts packages/host-runtime/test/harness-delegation-coordinator.test.ts
git commit -m "feat: require approval for delegation by default"
```

---

### Task 3: Enforce Native Approval Modes and Block Pi Safely

**Files:**
- Modify: `packages/adapters/omp/src/omp-permission-modes.ts:12-35`
- Modify: `packages/adapters/omp/src/omp-adapter.ts:1905-1920`
- Modify: `packages/adapters/omp/test/omp-adapter.test.ts:261-330`
- Modify: `packages/adapters/opencode/src/opencode-adapter.ts:1885-1915`
- Modify: `packages/adapters/opencode/src/server-connection.ts:130-150`
- Modify: `packages/adapters/opencode/test/opencode-adapter.test.ts`
- Modify: `packages/adapters/grok/test/grok-adapter.test.ts`
- Modify: `packages/adapters/claude-code/test/claude-code-adapter.test.ts`
- Modify: `packages/adapters/pi/src/pi-adapter.ts:1640-1665`
- Modify: `packages/adapters/pi/test/pi-adapter.test.ts:400-430`
- Modify: `packages/adapters/deepseek-harness/src/deepseek-harness-adapter.ts:1820-1865,2035-2115`
- Modify: `packages/adapters/deepseek-harness/test/deepseek-harness-adapter.test.ts:1420-1510`

**Interfaces:**
- Consumes: Task 1 `approval-required` policy.
- Produces: explicit safe native modes for OMP/OpenCode and verified safe-default selection for DeepSeek.
- Produces: Pi `unsupported` result for approval-required opens.
- Preserves: Claude Code `default` and Grok `ask` mappings, guarded by regression tests.

- [ ] **Step 1: Write failing OMP and OpenCode tests**

Replace the OMP ordinary-default assertion with:

```ts
expect(createTransport).toHaveBeenCalledWith(
  expect.objectContaining({ permissionMode: "always-ask" }),
);
```

Add an OpenCode approval-required test that asserts the connection environment contains a catch-all ask rule:

```ts
expect(connectionOptions[0]?.environment).toMatchObject({
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "ask" }),
});
```

Add Claude Code and Grok regression assertions for `default` and `ask` respectively.

- [ ] **Step 2: Write failing Pi and DeepSeek tests**

Replace the Pi test that says execution policy is ignored:

```ts
await expect(
  adapter.open({
    kind: "create",
    cwd: "/synthetic",
    executionPolicy: "approval-required",
  }),
).resolves.toMatchObject({
  ok: false,
  error: { code: "unsupported", retryable: false },
});
```

Also assert `unattended-full-access` still opens Pi.

For DeepSeek, enable the fixture permission catalog and assert approval-required executes `/permission team-safe`. Add cases for no catalog, `danger-full-access` as the default, and a projection that does not confirm the selected value; each must fail before a successful child session is returned.

- [ ] **Step 3: Run adapter tests and verify RED**

```bash
npm run build:typescript && npx vitest run packages/adapters/omp/test/omp-adapter.test.ts packages/adapters/opencode/test/opencode-adapter.test.ts packages/adapters/grok/test/grok-adapter.test.ts packages/adapters/claude-code/test/claude-code-adapter.test.ts packages/adapters/pi/test/pi-adapter.test.ts packages/adapters/deepseek-harness/test/deepseek-harness-adapter.test.ts --config tests/vitest.config.js
```

Expected: OMP still uses `yolo`, OpenCode does not force `ask`, Pi opens without approval support, and DeepSeek does not select a safe default.

- [ ] **Step 4: Implement OMP, OpenCode, and Pi behavior**

Set:

```ts
export const OMP_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("always-ask");
```

Map OpenCode `approval-required` to `ask` both in the selected permission mode and managed server environment. Reject Pi immediately:

```ts
if (input.executionPolicy === "approval-required") {
  return {
    ok: false,
    error: {
      code: "unsupported",
      message: "Pi does not expose approval controls required for delegated execution",
      retryable: false,
    },
  };
}
```

- [ ] **Step 5: Implement DeepSeek safe-default selection and confirmation**

For create opens with `approval-required`, require a catalog, select `permissionModes.defaultModeId`, reject `danger-full-access`, execute the native permission command, and require the post-create projected state to equal the requested mode. Reuse existing catalog and projection validators.

- [ ] **Step 6: Run adapter tests and verify GREEN**

Run the Step 3 command. Expected: all selected adapter tests pass.

- [ ] **Step 7: Commit adapter enforcement**

```bash
git add packages/adapters/omp packages/adapters/opencode packages/adapters/grok/test packages/adapters/claude-code/test packages/adapters/pi packages/adapters/deepseek-harness
git commit -m "fix: enforce approval modes across harnesses"
```

---

### Task 4: Apply the Same Policy to Official Codex Delegation

**Files:**
- Modify: `packages/host-runtime/src/app-server-host.ts:1200-1310`
- Modify: `packages/host-runtime/test/app-server-host.test.ts:1400-1490`

**Interfaces:**
- Consumes: Task 2 `DelegationStartInput.executionPolicy`.
- Produces: official `thread/start` mapping: approval-required → `on-request`/`workspace-write`; unattended → `never`/`danger-full-access`.

- [ ] **Step 1: Write failing official delegation tests**

Change the default request expectation:

```ts
expect(requests).toContainEqual({
  method: "thread/start",
  params: expect.objectContaining({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  }),
});
```

Add a second start with `executionPolicy: "unattended-full-access"` and retain the existing `never`/`danger-full-access` assertion for that explicit case. Add policy to the official delegation digest test.

- [ ] **Step 2: Run the test and verify RED**

```bash
npm run build:typescript && npx vitest run packages/host-runtime/test/app-server-host.test.ts --config tests/vitest.config.js
```

Expected: default official delegation still sends `never` and `danger-full-access`.

- [ ] **Step 3: Map the normalized policy**

```ts
const executionPolicy = input.executionPolicy ?? "approval-required";
const unattended = executionPolicy === "unattended-full-access";
```

Use:

```ts
approvalPolicy: unattended ? "never" : "on-request",
sandbox: unattended ? "danger-full-access" : "workspace-write",
```

Include `executionPolicy` in the official digest and returned configuration evidence.

- [ ] **Step 4: Run the test and verify GREEN**

Run the Step 2 command. Expected: the selected test file passes.

- [ ] **Step 5: Commit official mapping**

```bash
git add packages/host-runtime/src/app-server-host.ts packages/host-runtime/test/app-server-host.test.ts
git commit -m "fix: require approvals for official delegation"
```

---

### Task 5: Add Read-Only Status and Safe Skill Uninstall

**Files:**
- Modify: `packages/host-runtime/src/delegation-skill.ts`
- Modify: `packages/host-runtime/src/index.ts:45-50`
- Modify: `packages/host-runtime/test/delegation-skill.test.ts`

**Interfaces:**
- Produces: `inspectDelegationSkills(input?): Promise<DelegationSkillStatusResult[]>`.
- Produces: `uninstallDelegationSkills(input?): Promise<DelegationSkillUninstallResult[]>`.
- Consumes: the existing current digest, previous managed digests, fixed destinations, and optional test home directory.

- [ ] **Step 1: Write failing status tests**

Add tests for missing, current, legacy, and modified files:

```ts
await expect(inspectDelegationSkills({ homeDirectory: root })).resolves.toMatchObject([
  { status: "missing" },
  { status: "missing" },
]);
```

After installation, expect `current`; after writing a known previous digest, expect `managed-legacy`; after writing `user content\n`, expect `conflict`. Verify status leaves file content and mtime unchanged.

- [ ] **Step 2: Write failing uninstall tests**

```ts
const removed = await uninstallDelegationSkills({ homeDirectory: root });
expect(removed.map(({ status }) => status)).toEqual(["removed", "removed"]);
await expect(Promise.all(paths(root).map((file) => stat(file)))).rejects.toMatchObject({
  code: "ENOENT",
});
```

Add a conflict case that proves modified content remains byte-for-byte unchanged.

- [ ] **Step 3: Run tests and verify RED**

```bash
npm run build:typescript && npx vitest run packages/host-runtime/test/delegation-skill.test.ts --config tests/vitest.config.js
```

Expected: the two lifecycle functions are not exported.

- [ ] **Step 4: Implement shared classification and safe removal**

Use a single internal classifier for all three operations:

```ts
type ManagedSkillState = "missing" | "current" | "managed-legacy" | "conflict";
```

`inspect` only reads. `uninstall` calls `rm(destination)` only for `current` and `managed-legacy`. Treat `ENOENT` as `missing`; propagate other filesystem errors. Do not remove parent directories.

- [ ] **Step 5: Run tests and verify GREEN**

Run the Step 3 command. Expected: all Skill lifecycle tests pass.

- [ ] **Step 6: Commit lifecycle API**

```bash
git add packages/host-runtime/src/delegation-skill.ts packages/host-runtime/src/index.ts packages/host-runtime/test/delegation-skill.test.ts
git commit -m "feat: add safe delegation skill lifecycle"
```

---

### Task 6: Expose Skill CLI and Remove Startup Writes

**Files:**
- Modify: `packages/host-runtime/src/delegation-cli.ts`
- Modify: `packages/host-runtime/src/run-host-runtime.ts:1-130`
- Modify: `packages/host-runtime/test/delegation-cli.test.ts`
- Modify: `crates/launcher/src/main.rs:120-145,1140-1170`
- Modify: `crates/launcher/tests/cli.rs`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 5 lifecycle functions.
- Produces: `codexhost skill install|uninstall|status` JSON commands.
- Changes: Host Runtime startup has no delegation Skill filesystem action.

- [ ] **Step 1: Write failing TypeScript CLI tests**

Allow tests to inject a temporary home directory through the existing `runDelegationCli` input. Add:

```ts
await runDelegationCli({
  arguments: ["skill", "install"],
  output,
  homeDirectory: root,
});
expect(JSON.parse(outputText(output))).toMatchObject({
  operation: "install",
  results: [{ status: "installed" }, { status: "installed" }],
});
```

Repeat for `status` and `uninstall`. Assert an unknown Skill command exits with `INVALID_ARGUMENT` JSON.

- [ ] **Step 2: Write a failing launcher routing test**

Run the compiled launcher with `skill status` and assert it is routed to bundled Node resources rather than rejected as invalid launcher arguments:

```rust
let output = Command::new(launcher_path())
    .args(["skill", "status"])
    .output()
    .expect("run skill status");
let stderr = String::from_utf8_lossy(&output.stderr);
assert!(!stderr.contains("invalid launcher arguments"));
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm run build:typescript && npx vitest run packages/host-runtime/test/delegation-cli.test.ts --config tests/vitest.config.js
```

Expected: `skill` is rejected as an unsupported command group.

Run after Rust is available:

```bash
cargo test --locked --package codexhost-launcher --test cli production_launcher_routes_skill_commands
```

Expected before implementation: the launcher reports invalid arguments.

- [ ] **Step 4: Implement CLI routing and JSON output**

Add `skill` to launcher usage and the existing Node CLI routing match. In TypeScript, dispatch exact no-positional commands to Task 5 functions and write:

```ts
writeJson(output, { operation: command, results });
```

No Skill command should read Runtime endpoint/token environment variables.

- [ ] **Step 5: Remove automatic installation from Host startup**

Delete the `installDelegationSkills` import and the complete startup call chain from `prepareDelegationRuntime`. Keep delegation control server creation unchanged.

Verify source ownership with:

```bash
rg -n "installDelegationSkills" packages/host-runtime/src/run-host-runtime.ts
```

Expected: no matches.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the TypeScript and Rust commands from Step 3. Expected: all available checks pass.

- [ ] **Step 7: Commit explicit Skill management**

```bash
git add packages/host-runtime/src/delegation-cli.ts packages/host-runtime/src/run-host-runtime.ts packages/host-runtime/test/delegation-cli.test.ts crates/launcher/src/main.rs crates/launcher/tests/cli.rs README.md
git commit -m "feat: manage delegation skill explicitly"
```

---

### Task 7: Add the Reviewed Desktop Identity Manifest

**Files:**
- Create: `tools/codex-desktop-contract-audit/reviewed-desktops.json`
- Create: `tools/codex-desktop-contract-audit/reviewed-desktops.mjs`
- Create: `tools/codex-desktop-contract-audit/reviewed-desktops.test.mjs`

**Interfaces:**
- Produces: `parseReviewedDesktopManifest(value, manifestDirectory)`.
- Produces: `findReviewedDesktop(manifest, identity)`.
- Produces: entries `{ platform, version, build, asarIntegrity, baseline }` with confined baseline paths.

- [ ] **Step 1: Write failing manifest tests**

Create tests for exact match, mismatch, duplicates, malformed digest, and escaping baseline paths:

```js
const identity = {
  platform: "macos",
  version: "26.825.41651",
  build: "7345",
  asarIntegrity:
    "sha256:c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d",
};

expect(findReviewedDesktop(manifest, identity)).toMatchObject(identity);
expect(() => findReviewedDesktop(manifest, { ...identity, build: "7346" })).toThrow(
  "not reviewed",
);
```

Path confinement must reject `../outside.json` and absolute paths.

- [ ] **Step 2: Run the test and verify RED**

```bash
npx vitest run tools/codex-desktop-contract-audit/reviewed-desktops.test.mjs --config tests/vitest.config.js
```

Expected: the module does not exist.

- [ ] **Step 3: Implement bounded manifest parsing with Node standard library**

Use `path.resolve`/`path.relative`, exact scalar checks, a `sha256:<64 lowercase hex>` regular expression, and a compound identity key. Reject empty lists and duplicate identities. Do not add a validation dependency.

- [ ] **Step 4: Add the first reviewed entry**

```json
{
  "schemaVersion": 1,
  "desktops": [
    {
      "platform": "macos",
      "version": "26.825.41651",
      "build": "7345",
      "asarIntegrity": "sha256:c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d",
      "baseline": "baselines/macos-26.825.41651-7345.json"
    }
  ]
}
```

- [ ] **Step 5: Run the test and verify GREEN**

Run the Step 2 command. Expected: all manifest tests pass.

- [ ] **Step 6: Commit the identity gate**

```bash
git add tools/codex-desktop-contract-audit/reviewed-desktops.json tools/codex-desktop-contract-audit/reviewed-desktops.mjs tools/codex-desktop-contract-audit/reviewed-desktops.test.mjs
git commit -m "feat: pin reviewed codex desktop identities"
```

---

### Task 8: Build the Controlled Integration and Baseline Acceptance Commands

**Files:**
- Create: `tools/codex-desktop-contract-audit/integration.mjs`
- Create: `tools/codex-desktop-contract-audit/integration.test.mjs`
- Create: `tools/codex-desktop-contract-audit/accept-baseline.mjs`
- Create: `tools/codex-desktop-contract-audit/accept-baseline.test.mjs`
- Create after reviewed audit: `tools/codex-desktop-contract-audit/baselines/macos-26.825.41651-7345.json`
- Modify: `tools/codex-desktop-contract-audit/run.mjs`
- Modify: `tools/codex-desktop-contract-audit/run.test.mjs`
- Modify: `tools/codex-desktop-contract-audit/README.md`
- Modify: `package.json:65-75`

**Interfaces:**
- Consumes: Task 7 manifest functions and the existing audit report validator.
- Produces: `runReviewedDesktopIntegration(input)` for exact-identity controlled audits.
- Produces: `acceptReviewedBaseline(input)` for explicit reviewed updates.
- Produces: npm scripts `test:codex-desktop:integration` and `accept:codex-desktop-baseline`.

- [ ] **Step 1: Write failing integration tests**

Inject identity and audit functions so tests do not launch a GUI:

```js
await expect(
  runReviewedDesktopIntegration({
    identity,
    manifest,
    runAudit: async () => ({ verdict: "no-impact", surfaces: [] }),
  }),
).resolves.toMatchObject({ verdict: "no-impact" });
```

Add mismatch, missing baseline, `possible-impact`, and `confirmed-impact` cases. Add an `unverified` case that succeeds and returns the exact unverified surface IDs as warnings.

- [ ] **Step 2: Write failing acceptance tests**

Use temporary directories. Assert a reviewed no-impact report populates a predeclared missing baseline, and that a new identity appends one manifest entry and writes a sanitized baseline. Assert possible/confirmed impact, an existing baseline, duplicate identity, wrong schema, and a report path outside the supplied root are rejected without changing either output file.

- [ ] **Step 3: Run tests and verify RED**

```bash
npx vitest run tools/codex-desktop-contract-audit/integration.test.mjs tools/codex-desktop-contract-audit/accept-baseline.test.mjs --config tests/vitest.config.js
```

Expected: both command modules are missing.

- [ ] **Step 4: Make the existing audit callable without changing default CLI behavior**

Export the existing identity reader and one `runCodexDesktopAudit(options)` function from `run.mjs`. Keep `main()` as a thin parser/caller and preserve current JSON output and exit code for `npm run audit:codex-desktop`.

Extend identity to include the launcher's bounded `platform` field. Explicit fixture identity must supply all four fields together: platform, version, build, and digest.

- [ ] **Step 5: Implement strict integration verdict handling**

The integration command must:

```text
read identity -> exact manifest match -> load confined baseline -> controlled audit
```

Throw for `possible-impact` or `confirmed-impact`. Return `unverifiedSurfaces` for unverified checks and print them to stderr while exiting zero.

- [ ] **Step 6: Implement explicit baseline acceptance**

Require `--report <absolute-or-repository-relative-json>`. Validate with `validateAuditReport`, reject possible/confirmed impact, copy only the validated report object, and update JSON through an atomic temporary-file rename. Refuse duplicates; adding a new build must append a new entry.

- [ ] **Step 7: Add npm scripts and documentation**

```json
"test:codex-desktop:integration": "npm run build:typescript && npm run build:renderer && node tools/codex-desktop-contract-audit/integration.mjs",
"accept:codex-desktop-baseline": "node tools/codex-desktop-contract-audit/accept-baseline.mjs"
```

Document exact identity failure, loopback endpoint options, warning semantics, and the manual acceptance workflow.

- [ ] **Step 8: Run focused tests and verify GREEN**

```bash
npx vitest run tools/codex-desktop-contract-audit/report.test.mjs tools/codex-desktop-contract-audit/run.test.mjs tools/codex-desktop-contract-audit/reviewed-desktops.test.mjs tools/codex-desktop-contract-audit/integration.test.mjs tools/codex-desktop-contract-audit/accept-baseline.test.mjs --config tests/vitest.config.js
```

Expected: all audit tool tests pass.

- [ ] **Step 9: Capture and accept the current controlled baseline**

Only when Codex Desktop can be safely stopped or attached without interrupting user work, run:

```bash
npm run audit:codex-desktop -- --mode controlled --endpoint http://127.0.0.1:9222 --inspector-endpoint http://127.0.0.1:9223 --desktop-platform macos --desktop-version 26.825.41651 --desktop-build 7345 --asar-integrity sha256:c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d
npm run accept:codex-desktop-baseline -- --report .codexhost/update-impact/26.825.41651/audit-report.json
```

Inspect the generated baseline diff and confirm it contains no prompt, transcript text, credentials, token, user path, complete URL, DOM dump, or bundle.

- [ ] **Step 10: Run the real fixed-version integration gate**

```bash
npm run test:codex-desktop:integration -- --endpoint http://127.0.0.1:9222 --inspector-endpoint http://127.0.0.1:9223
```

Expected: exact identity matches, no possible/confirmed impact is reported, and any unverified surfaces are listed as warnings.

- [ ] **Step 11: Commit the integration gate**

```bash
git add package.json tools/codex-desktop-contract-audit
git commit -m "test: gate reviewed codex desktop builds"
```

---

### Task 9: Align User Documentation and Run Final Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: all commands and behavior from Tasks 1-8.
- Produces: user-facing installation, permission, Pi limitation, and Desktop update instructions.

- [ ] **Step 1: Update documentation with exact commands and defaults**

Document:

```text
codexhost skill install
codexhost skill status
codexhost skill uninstall
codexhost delegate start ... --execution-policy unattended-full-access
npm run test:codex-desktop:integration
npm run accept:codex-desktop-baseline -- --report .codexhost/update-impact/26.825.41651/audit-report.json
```

State that delegation defaults to approval-required, Pi requires explicit unattended access, OMP defaults to always-ask, Host startup no longer installs Skills, and new Desktop builds require reviewed baseline acceptance.

- [ ] **Step 2: Run formatting checks**

```bash
npx prettier --check packages crates tools tests README.md docs package.json
cargo fmt --all --check
```

Expected: zero formatting failures. If the repository contains a pre-existing unrelated formatting failure, record the exact file and run Prettier against every changed file separately.

- [ ] **Step 3: Run lint and type checks**

```bash
npm run lint
npm run typecheck
```

Expected: both commands exit zero.

- [ ] **Step 4: Run the complete TypeScript suite**

```bash
npm run test:typescript
```

Expected: zero failing TypeScript tests. Distinguish environment/toolchain failures from product failures with exact test names.

- [ ] **Step 5: Run Rust verification**

```bash
npm run check:rust
```

Expected: rustfmt, Clippy with `-D warnings`, and all Rust tests pass. If Rust `1.97.1` is unavailable, report this check as blocked rather than passed.

- [ ] **Step 6: Review the final diff against the approved spec**

```bash
git status --short
git diff --check
git diff --stat 03a6b89..HEAD
rg -n "installDelegationSkills" packages/host-runtime/src/run-host-runtime.ts
rg -n 'OMP_DEFAULT_PERMISSION_MODE_ID.*yolo' packages/adapters/omp/src
```

Expected: no uncommitted code, no whitespace errors, no automatic Skill install call, and no OMP `yolo` default.

- [ ] **Step 7: Commit documentation corrections if needed**

```bash
git add README.md docs
git commit -m "docs: explain safer delegation controls"
```

Skip this commit when Task 6 and Task 8 already left documentation fully aligned and the working tree is clean.
