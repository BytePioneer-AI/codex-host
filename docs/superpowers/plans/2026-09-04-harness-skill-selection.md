# Harness Skill Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Claude Code Thread in Codex Desktop discover and execute its natively enumerated skills through a dedicated Composer Skills button (+ `Cmd/Ctrl+Shift+S`), and align Claude context loading with the CLI (`settingSources` user+project+local).

**Architecture:** The Claude Adapter enumerates skills from the Agent SDK (`system/init` message `skills` list + `supportedCommands()` + `system/commands_changed` push), projects them as a second `HarnessCommandCapability` (`session.skills`). The Host adds one read-only inspect RPC and extends the existing `command/execute` boundary to validate against the union of the Thread's two catalogs. The Renderer adds an independent Skills popover beside the existing Harness Commands control. Skills execute by submitting `/<name> [args]` through the existing `runTurn` transport — no raw-RPC passthrough, no SKILL.md parsing outside the CLI.

**Tech Stack:** TypeScript (strict, zod 4 schemas, vitest), Claude Agent SDK 0.3.220 (`node_modules/@anthropic-ai/claude-agent-sdk`), DOM-injected renderer extension (esbuild bundle), no Rust changes.

**Spec:** `openspec/changes/add-harness-skill-selection/` (proposal.md, design.md, specs/harness-skill-catalog/spec.md, specs/harness-command-capabilities/spec.md, tasks.md). Read all four before starting any task.

## Global Constraints

- Brand name always lowercase: `codexhost`. Conventional Commits prefixes (`feat:`/`fix:`/`test:`/`docs:`).
- Package layering enforced by `tools/check-boundaries.mjs` (runs inside `npm run lint`): Harness-specific protocol details stay inside `packages/adapters/claude-code`; `shared-contracts` and `protocol-core` stay Harness-neutral; `renderer-extension` must not import Node builtins/Electron/Harness SDKs.
- TypeScript strict mode, ESLint, Prettier (`printWidth 100`, double quotes, trailing commas). Format with `npm run format` before committing.
- Test runner: `npx vitest run --config tests/vitest.config.js <path>` after `npm run build:typescript`.
- Skill command IDs use prefix `claude.skill.`; static `claudeCommandCatalog` (compact/init/recap) is never merged into the Skills catalog, and vice versa.
- Unknown command IDs are rejected at the Host boundary; no arbitrary native string is ever executed.
- Do NOT run `gate:a`/`gate:c`/`gate:claude` suites; they hit real installs.

## File Map

| File | Change |
|---|---|
| `packages/adapters/claude-code/src/sdk-transport.ts` | settingSources ×2, skill snapshot state, `commands_changed` consume branch, `listSkills()` |
| `packages/adapters/claude-code/src/transport.ts` | `ClaudeSkillCommand` type + `listSkills()` on `ClaudeTurnTransport` |
| `packages/adapters/claude-code/src/claude-code-adapter.ts` | `projectClaudeSkillCatalog`, `parseClaudeSkillInvocation`, `session.skills` capability, `#beginCommandTurn` refactor, `claude.skill` branch |
| `packages/adapters/claude-code/test/sdk-transport.test.ts` | FakeQuery gains `supportedCommands`/init fields; settingSources + commands_changed tests |
| `packages/adapters/claude-code/test/claude-code-adapter.test.ts` | FakeClaudeTransport gains `listSkills`; projection/execution/busy tests |
| `packages/shared-contracts/src/harness-commands.ts` | (no new schema — reused) |
| `packages/host-runtime/src/app-server-host.ts` | `codexhost/thread/skills/inspect` route + union validation in `#executeThreadCommand`; `#startExternalCommand` takes capability |
| `packages/host-runtime/test/app-server-host.test.ts` | skills inspect/execute/isolation tests |
| `packages/harness-adapter/src/text-session.ts` | `HarnessSession.skills?: HarnessCommandCapability` |
| `packages/harness-adapter/src/testing.ts` | `FakeHarnessSession.skills` mutable field |
| `packages/renderer-extension/src/renderer-model-client.ts` | `THREAD_SKILLS_INSPECT_METHOD` + `inspectThreadSkills` |
| `packages/renderer-extension/src/versioned-renderer-adapter.ts` | pass-through `inspectThreadSkills` |
| `packages/renderer-extension/src/renderer-harness-skill-control.ts` | **new** — Skills button + popover (filter + argument phase) |
| `packages/renderer-extension/src/renderer-harness-localization.ts` | `skills`, `back`, `argumentFor` message keys (en/zh-CN) |
| `packages/renderer-extension/src/renderer-composer-dom.ts` | mount + placement chain + setLocale + dispose |
| `packages/renderer-extension/src/renderer-binding-probe.ts` | `refreshSkills`, `executeSkill`, `Cmd/Ctrl+Shift+S` in `onKeyDown` |
| `packages/renderer-extension/test/renderer-harness-skill-control.test.ts` | **new** — control DOM tests |
| `docs/harness-command-integration.md` | skill integration path + SKILL.md boundary re-affirmation |

---

### Task 1: Transport skill snapshot and CLI-aligned settingSources

**Files:**
- Modify: `packages/adapters/claude-code/src/sdk-transport.ts` (settingSources at :422 and :891; `start()` :403-447; `#consume()` :756-823; add fields near :369)
- Modify: `packages/adapters/claude-code/src/transport.ts` (`ClaudeTurnTransport` :168-201)
- Modify: `packages/adapters/claude-code/test/sdk-transport.test.ts` (FakeQuery :19-117)
- Modify: `packages/adapters/claude-code/test/claude-code-adapter.test.ts` (FakeClaudeTransport :32 — add `listSkills` in THIS task so the interface addition doesn't break `npm run typecheck` between commits; Task 2's tests reuse it)

**Interfaces:**
- Consumes: SDK `Query.supportedCommands(): Promise<SlashCommand[]>` where `SlashCommand = { name: string; description: string; argumentHint: string; aliases?: string[] }`; stream messages `system/init` carrying `skills: string[]` and `slash_commands: string[]`, and `system/commands_changed` carrying `commands: SlashCommand[]` (REPLACE semantics).
- Produces (Task 2 depends on these exact names):
  ```ts
  // transport.ts
  export interface ClaudeSkillCommand {
    readonly name: string;
    readonly description: string;
    readonly argumentHint: string;
  }
  // added to ClaudeTurnTransport:
  listSkills(): Promise<readonly ClaudeSkillCommand[]>; // [] when transport unstarted or enumeration unsupported
  ```

- [ ] **Step 1: Write the failing tests** in `packages/adapters/claude-code/test/sdk-transport.test.ts`. Verified seams: `FakeQuery` (class at :19) feeds `#consume` via `push(message: SDKMessage)` with a waiter queue; the file's factory is `fixture(openMode?, permissionMode?, thinkingOptionId?, environment?)` returning `{ fakeQuery, onFault, onPermissionModeChanged, onPlanLimit, queryFactory, queryInput, transport }`; the options accessor is `options(value)` (test-local helper) or `value.queryInput().options`. Extend `FakeQuery` with one field:

```ts
class FakeQuery {
  // ...existing members unchanged...
  supportedCommands = vi.fn(async () => [
    { name: "render-html", description: "Render HTML", argumentHint: "<file>", aliases: [] },
    { name: "compact", description: "built-in", argumentHint: "", aliases: [] },
  ]);
}
```

(`FakeQuery` is cast `as unknown as Query` in `fixture`, so an added method needs no type gymnastics.)

Add tests (message payloads are cast `as unknown as SDKMessage` following the file's existing push helpers at :120-157; the consume loop is async, so read the snapshot through `vi.waitFor`):

```ts
it("starts the session with CLI-aligned setting sources", async () => {
  const value = fixture();
  await value.transport.start();
  expect(options(value).settingSources).toEqual(["user", "project", "local"]);
});

it("listSkills returns only natively reported skill names", async () => {
  const value = fixture();
  await value.transport.start();
  value.fakeQuery.push({
    type: "system",
    subtype: "init",
    skills: ["render-html"],
    slash_commands: ["/compact"],
    session_id: "s1",
    uuid: "u1",
  } as unknown as SDKMessage);
  await vi.waitFor(async () => {
    await expect(value.transport.listSkills()).resolves.toEqual([
      { name: "render-html", description: "Render HTML", argumentHint: "<file>" },
    ]);
  });
});

it("listSkills includes skills announced by commands_changed pushes", async () => {
  const value = fixture();
  await value.transport.start();
  value.fakeQuery.push({
    type: "system",
    subtype: "init",
    skills: ["render-html"],
    slash_commands: ["/compact"],
    session_id: "s1",
    uuid: "u1",
  } as unknown as SDKMessage);
  value.fakeQuery.supportedCommands.mockResolvedValue([
    { name: "render-html", description: "Render HTML", argumentHint: "<file>" },
    { name: "pdf-tools:extract", description: "Extract text", argumentHint: "" },
    { name: "compact", description: "built-in", argumentHint: "" },
  ]);
  value.fakeQuery.push({
    type: "system",
    subtype: "commands_changed",
    commands: [
      { name: "render-html", description: "Render HTML", argumentHint: "<file>" },
      { name: "pdf-tools:extract", description: "Extract text", argumentHint: "" },
      { name: "compact", description: "built-in", argumentHint: "" },
    ],
    session_id: "s1",
    uuid: "u2",
  } as unknown as SDKMessage);
  await vi.waitFor(async () => {
    await expect(value.transport.listSkills()).resolves.toEqual([
      { name: "render-html", description: "Render HTML", argumentHint: "<file>" },
      { name: "pdf-tools:extract", description: "Extract text", argumentHint: "" },
    ]);
  });
});

it("listSkills degrades to empty when the installed CLI lacks enumeration", async () => {
  const value = fixture();
  delete (value.fakeQuery as { supportedCommands?: unknown }).supportedCommands;
  await value.transport.start();
  await expect(value.transport.listSkills()).resolves.toEqual([]);
});
```

If any existing assertion pins `settingSources` to `["user"]`, update it to the triple in the same edit.

Also add to `FakeClaudeTransport` in `claude-code-adapter.test.ts` (:32) — required because the widened interface would otherwise fail typecheck at this commit:

```ts
skills: ClaudeSkillCommand[] = [];
readonly listSkills = vi.fn(async () => this.skills);
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run build:typescript
npx vitest run --config tests/vitest.config.js packages/adapters/claude-code/test/sdk-transport.test.ts
```
Expected: FAIL (`settingSources` is `["user"]`; `listSkills` not a function).

- [ ] **Step 3: Implement** in `sdk-transport.ts`:

1. Both `settingSources: ["user"]` literals (:422 in `ClaudeSdkTransport.start`, :891 in `ClaudeSdkModelInspector.inspect`) become `settingSources: ["user", "project", "local"]`. The inspector change is deliberate: project skills/settings must resolve identically for catalog and session paths.
2. Add private state near the other `#` fields (~:369):

```ts
#skillNames = new Set<string>();
#builtInCommandNames = new Set<string>();
```

3. In `#consume` (the loop at :757), before the `#active` branch, add alongside the existing `permissionModeFromMessage` handling:

```ts
if (isRecord(message) && message.type === "system") {
  if (message.subtype === "init" && Array.isArray(message.skills) && Array.isArray(message.slash_commands)) {
    this.#skillNames = new Set(
      message.skills.filter((name: unknown): name is string => typeof name === "string"),
    );
    this.#builtInCommandNames = new Set(
      (message.slash_commands as unknown[])
        .filter((name: unknown): name is string => typeof name === "string")
        .map((name) => (name.startsWith("/") ? name.slice(1) : name)),
    );
  } else if (message.subtype === "commands_changed" && Array.isArray(message.commands)) {
    for (const command of message.commands as readonly Record<string, unknown>[]) {
      if (typeof command.name === "string" && !this.#builtInCommandNames.has(command.name)) {
        this.#skillNames.add(command.name);
      }
    }
  }
}
```

4. In `start()`, after `await activeQuery.initializationResult();` (:438), keep no extra call — freshness comes from `listSkills`. Add the public method next to `compact/init/recap` (:486-511):

```ts
async listSkills(): Promise<readonly ClaudeSkillCommand[]> {
  const activeQuery = this.#query;
  if (!this.#started || !activeQuery) return [];
  const supported = (
    activeQuery as Partial<Pick<Query, "supportedCommands">>
  ).supportedCommands;
  if (typeof supported !== "function") return [];
  try {
    const commands = await supported.call(activeQuery);
    return commands
      .filter((command) => this.#skillNames.has(command.name))
      .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
  } catch {
    return [];
  }
}
```

Export `ClaudeSkillCommand` from `transport.ts` (interface above, plus `listSkills(): Promise<readonly ClaudeSkillCommand[]>;` inside `ClaudeTurnTransport`) and import it in `sdk-transport.ts`. The structural cast above exists because `query()`'s `Query` type may not carry `supportedCommands` on every installed CLI version — keep the `typeof supported !== "function"` guard.

- [ ] **Step 4: Run tests** — same command as Step 2. Expected: PASS (pre-existing `settingSources` assertions, if any, updated to the new triple in the same edit).

- [ ] **Step 5: Commit**

```bash
npm run format
git add packages/adapters/claude-code
git commit -m "feat: enumerate Claude skills from native SDK surface"
```

---

### Task 2: Adapter skills capability and projection

**Files:**
- Modify: `packages/adapters/claude-code/src/claude-code-adapter.ts` (catalog :182-206, `parseClaudeHarnessCommand` :208-261, `#executeHarnessCommand` :785-893, session class :478-530)
- Modify: `packages/harness-adapter/src/text-session.ts` (`HarnessSession` :488-510)
- Modify: `packages/harness-adapter/src/testing.ts` (`FakeHarnessSession` :153-165)
- Test: `packages/adapters/claude-code/test/claude-code-adapter.test.ts` (FakeClaudeTransport :32-, helpers :249-)

**Interfaces:**
- Consumes: Task 1's `transport.listSkills()`.
- Produces (Tasks 3-4 depend on these exact names):
  - `HarnessSession.skills?: HarnessCommandCapability` (same `{list, execute}` shape as `commands`).
  - Skill command IDs: `` `claude.skill.${name.replaceAll(".", "..")}` `` — e.g. skill `render-html` → `claude.skill.render-html`; skill `no-arg.skill` → `claude.skill.no-arg..skill`; plugin-qualified `pdf-tools:extract` → `claude.skill.pdf-tools:extract` (colon already passes the ID regex). Escaping makes IDs injective in the skill name; the display `invocation` carries the raw name, and execution reads the name from the cached descriptor, never by decoding the ID.
  - Execute argument shape: `{ text: string }` only, mirroring compact (`arguments` absent for `argumentMode: "none"`).
  - Exported pure helpers for tests: `projectClaudeSkillCatalog(skills: readonly ClaudeSkillCommand[]): HarnessResult<HarnessCommandCatalog>`.

- [ ] **Step 1: Extend the session contract.** In `text-session.ts` `HarnessSession` (:495 area) add after `readonly commands?: HarnessCommandCapability;`:

```ts
readonly skills?: HarnessCommandCapability;
```

In `testing.ts` `FakeHarnessSession`, mirror the existing mutable `commands?: HarnessCommandCapability` field (:159) with `skills?: HarnessCommandCapability;` so Host tests can assign it post-construction like they already assign `commands` (app-server-host.test.ts:3088 pattern).

- [ ] **Step 2: Write the failing tests** in `claude-code-adapter.test.ts`. Verified seams: file factory is `fixture(options?) → { adapter, dependencies, history, inspectors, inspectInstallation, transports }` (:205); session via `openSession(adapter)` (:267); the fake transport appears in `transports[]` once any operation triggers `#ensureTransport`; turn-event driving pattern at :1161-1192 (`transport.event(...)`, `transport.finish({ status: "succeeded" })`); `runTurn` already records `transports[].turns.push({ text, userMessageId })` (:137-148). `FakeClaudeTransport` already carries the Task-1 `skills`/`listSkills` members. Then:

```ts
it("projects native skills into a claude.skill catalog", async () => {
  const { adapter, transports } = fixture();
  const session = await openSession(adapter);
  await session.commands!.execute({
    turnId: hostTurnIdSchema.parse("prime"),
    commandId: "claude.recap",
  }); // force transport creation through any command path
  const transport = transports[0];
  if (!transport) throw new Error("Fake transport missing");
  transport.finish({ status: "succeeded" });
  transport.skills = [
    { name: "render-html", description: "Render HTML", argumentHint: "<file>" },
    { name: "no-arg.skill", description: "Dots escape", argumentHint: "" },
  ];
  await expect(session.skills!.list()).resolves.toMatchObject({
    ok: true,
    value: {
      commands: [
        { id: "claude.skill.render-html", invocation: "/render-html", label: "render-html", description: "Render HTML", argumentMode: "text" },
        { id: "claude.skill.no-arg..skill", invocation: "/no-arg.skill", label: "no-arg.skill", description: "Dots escape", argumentMode: "none" },
      ],
    },
  });
});

it("rejects duplicate projected skill IDs instead of dropping entries", async () => {
  const { adapter, transports } = fixture();
  const session = await openSession(adapter);
  await session.skills!.list(); // lazily creates transports[0]
  const transport = transports[0];
  if (!transport) throw new Error("Fake transport missing");
  transport.skills = [
    { name: "dup", description: "A", argumentHint: "" },
    { name: "dup", description: "B", argumentHint: "" },
  ];
  await expect(session.skills!.list()).resolves.toMatchObject({
    ok: false,
    error: { code: "protocolError" },
  });
});

it("executes a skill as a native slash turn with optional text argument", async () => {
  const { adapter, transports } = fixture();
  const session = await openSession(adapter);
  await session.skills!.list();
  const transport = transports[0];
  transport.skills = [{ name: "render-html", description: "d", argumentHint: "<file>" }];
  const iterator = session.outputs[Symbol.asyncIterator]();
  await expect(
    session.skills!.execute({
      turnId: hostTurnIdSchema.parse("skill-turn-1"),
      commandId: "claude.skill.render-html",
      arguments: { text: "report.html" },
    }),
  ).resolves.toEqual({ ok: true, value: { turnId: "skill-turn-1" } });
  expect(transport.turns.at(-1)?.text).toBe("/render-html report.html");
  // event sequence mirrors :1160-1192: turn.started, then a real agentMessage item lane
  // (startAgentItem must be true for skills) — drive transport.event/finish and assert
  // item.started carries type "agentMessage", turn.completed succeeds.
});

it("rejects skill execution for unknown id and for arguments on a none skill", async () => {
  const { adapter, transports } = fixture();
  const session = await openSession(adapter);
  await session.skills!.list();
  transports[0].skills = [{ name: "plain", description: "d", argumentHint: "" }];
  await expect(
    session.skills!.execute({ turnId: hostTurnIdSchema.parse("t0"), commandId: "claude.skill.ghost" }),
  ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
  await expect(
    session.skills!.execute({
      turnId: hostTurnIdSchema.parse("t1"),
      commandId: "claude.skill.plain",
      arguments: { text: "nope" },
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
});

it("reports sessionBusy when a skill executes during an active Turn", async () => {
  const { adapter, transports } = fixture();
  const session = await openSession(adapter);
  void session.execute(textTurn("busy-turn")); // file helper at :288
  await session.skills!.list(); // ensure transports exist
  transports[0].skills = [{ name: "plain", description: "d", argumentHint: "" }];
  await expect(
    session.skills!.execute({ turnId: hostTurnIdSchema.parse("t2"), commandId: "claude.skill.plain" }),
  ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
});
```

If `session.skills!.list()` during an active turn must not start a second transport, the lazy-bootstrap guard from Step 4's implementation already handles it; assert `transports.length === 1` in the busy test as a bonus.

- [ ] **Step 3: Run to verify failure**

```bash
npx vitest run --config tests/vitest.config.js packages/adapters/claude-code/test/claude-code-adapter.test.ts
```

- [ ] **Step 4: Implement.** In `claude-code-adapter.ts`:

```ts
function claudeSkillCommandId(name: string): string {
  return `claude.skill.${name.replaceAll(".", "..")}`;
}

export function projectClaudeSkillCatalog(
  skills: readonly ClaudeSkillCommand[],
): HarnessResult<HarnessCommandCatalog> {
  try {
    return {
      ok: true,
      value: harnessCommandCatalogSchema.parse({
        commands: skills.map((skill) => ({
          id: claudeSkillCommandId(skill.name),
          invocation: `/${skill.name}`,
          label: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
          argumentMode: skill.argumentHint.trim().length > 0 ? "text" : "none",
        })),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: `Claude skill catalog is invalid: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      },
    };
  }
}
```

Verified error-code enum (`text-session.ts:35-48`): `notInstalled | unavailable | authenticationRequired | sessionNotFound | sessionBusy | checkpointNotFound | unsupported | invalidRequest | invalidState | protocolError | processExited | nativeFailure | internalError`. Use `code: "protocolError"` for invalid projected catalogs (native returned entries that violate the published contract). Do not add a new code.

In `ClaudeSession`, beside `this.commands = { list…, execute… }` (:520-523) add:

```ts
this.skills = {
  list: async () => {
    if (this.#phase !== "open") return { ok: false, error: invalidState("Claude Code Session is not open") };
    const transport = this.#transport;
    if (!transport) {
      if (this.#acceptingTurn || this.#active || this.#configurationTask || this.#readingHistory) {
        return { ok: true, value: { commands: [] } };
      }
      this.#acceptingTurn = true;
      try {
        await this.#ensureTransport();
      } catch {
        return { ok: true, value: { commands: [] } };
      } finally {
        this.#acceptingTurn = false;
      }
    }
    const active = this.#transport;
    if (!active) return { ok: true, value: { commands: [] } };
    return projectClaudeSkillCatalog(await active.listSkills());
  },
  execute: (command) => this.#executeSkillCommand(command),
};
```

Declare `readonly skills: HarnessCommandCapability;` beside `readonly commands` (:486).

Refactor `#executeHarnessCommand` (:785-893): split its body after the busy/transport bootstrap into `#beginCommandTurn(command: HarnessCommandInvocation, parsed: ClaudeCommandTurn)`, where

```ts
type ClaudeCommandTurn =
  | { kind: "native"; native: ClaudeHarnessCommand }
  | { kind: "skill"; name: string; text: string | undefined };
```

Inside `#beginCommandTurn`, the running dispatch (:868-876) becomes:

```ts
const running =
  parsed.kind === "skill"
    ? transport.runTurn(
        parsed.text ? `/${parsed.name} ${parsed.text}` : `/${parsed.name}`,
        nativeTurnKey,
        (event) => this.#handleTurnEvent(active, event),
      )
    : parsed.native.id === "claude.compact"
      ? transport.compact(/* unchanged */)
      : parsed.native.id === "claude.init"
        ? transport.init(/* unchanged */)
        : transport.recap(/* unchanged */);
```

`startAgentItem` (:833) becomes `parsed.kind === "skill" || parsed.native.id !== "claude.compact"` — a skill Turn is a normal visible agent reply, never an ephemeral compaction lane.

Add the skill entry point:

```ts
async #executeSkillCommand(
  command: HarnessCommandInvocation,
): Promise<HarnessResult<HarnessCommandAccepted>> {
  if (!command.commandId.startsWith("claude.skill.")) {
    return { ok: false, error: unsupported(`Not a Claude skill command`) }; // reuse the existing error factories in this file
  }
  const listed = await this.skills!.list();
  if (!listed.ok) return listed;
  const descriptor = listed.value.commands.find(({ id }) => id === command.commandId);
  if (!descriptor) {
    return { ok: false, error: { code: "unsupported", message: `Claude Code does not expose skill '${command.commandId}'`, retryable: false } };
  }
  const name = descriptor.invocation.slice(1);
  const args = command.arguments;
  if (descriptor.argumentMode === "none" && args && Object.keys(args).length > 0) {
    return { ok: false, error: { code: "invalidRequest", message: `Claude Code skill '${name}' does not accept arguments`, retryable: false } };
  }
  if (args && Object.keys(args).some((key) => key !== "text")) {
    return { ok: false, error: { code: "invalidRequest", message: `Claude Code skill '${name}' has an unknown argument`, retryable: false } };
  }
  const text = args?.text;
  if (text !== undefined && typeof text !== "string") {
    return { ok: false, error: { code: "invalidRequest", message: `Claude Code skill '${name}' argument 'text' must be a string`, retryable: false } };
  }
  // Same pre-flight as #executeHarnessCommand: phase check, then delegate.
  return this.#beginCommandTurn(command, { kind: "skill", name, text: typeof text === "string" ? text : undefined });
}
```

`#beginCommandTurn` carries the existing `#acceptingTurn`/`#phase`/busy checks from :787-834 unchanged; `#executeHarnessCommand` becomes phase-check + `parseClaudeHarnessCommand` + `#beginCommandTurn`.

- [ ] **Step 5: Run tests** — adapter + harness-adapter suites:

```bash
npm run build:typescript
npx vitest run --config tests/vitest.config.js packages/adapters/claude-code/test/claude-code-adapter.test.ts packages/harness-adapter
```

- [ ] **Step 6: Commit**

```bash
npm run format
git add packages/adapters/claude-code packages/harness-adapter
git commit -m "feat: expose Claude skill catalog and executor through the Adapter seam"
```

---

### Task 3: Host skills inspect route and union execution routing

**Files:**
- Modify: `packages/host-runtime/src/app-server-host.ts` (route table :752-759, `#inspectThreadCommands` :1980-2010, `#executeThreadCommand` :2012-2068, `#startExternalCommand` :2070-2106)
- Test: `packages/host-runtime/test/app-server-host.test.ts` (fixture pattern :3084-3160)

**Interfaces:**
- Consumes: Task 2's `session.skills` on `HarnessSession` and FakeHarnessSession.
- Produces: JSON-RPC method `codexhost/thread/skills/inspect`, params `{ threadId }` (reuse `threadCommandsInspectParamsSchema`), result = `HarnessCommandCatalog` shape (`{ commands: [...] }`). `codexhost/thread/command/execute` now accepts IDs from either catalog. **Discovery (missed in the first draft, verified at app-server-host.ts:2995-3020): the ordinary `turn/start` text path already intercepts text matching the Commands catalog** (`/compact foo` → command execution, longest-invocation-first). Skills must join that interception or typing `/skill-name` into the composer would reach Claude as a plain text Turn and render wrong.

- [ ] **Step 1: Write the failing tests** in `app-server-host.test.ts`, mirroring the "acknowledges an accepted Harness command" test (:3084) and the inspect tests it neighbours:

```ts
it("returns an empty skills catalog for Harnesses without the capability", async () => {
  const fixture = createFixture();
  const threadId = await startPiThread(fixture);
  writeRequest(fixture.desktopInput, {
    id: 3,
    method: "codexhost/thread/skills/inspect",
    params: { threadId },
  });
  await expect(
    fixture.collector.waitFor((message) => requestId(message, 3)),
  ).resolves.toMatchObject({ result: { commands: [] } });
  await stopFixture(fixture);
});

it("inspects and executes a skill through the unified command route", async () => {
  const fixture = createFixture();
  const threadId = await startPiThread(fixture);
  const session = fixture.adapter.sessions[0];
  session.commands = { /* one fake.compact entry, as :3088 */ };
  session.skills = {
    list: async () => ({
      ok: true,
      value: {
        commands: [harnessCommandDescriptorSchema.parse({
          id: "fake.skill.render",
          invocation: "/render",
          label: "render",
          argumentMode: "text",
        })],
      },
    }),
    execute: async ({ turnId, commandId, arguments: arguments_ }) => {
      expect(commandId).toBe("fake.skill.render");
      expect(arguments_).toEqual({ text: "a.html" });
      // Verified FakeHarnessSession API (testing.ts:256): publish an item + complete the turn
      session.publishEphemeralCommand(turnId, {
        type: "contextCompaction",
        itemId: hostItemIdSchema.parse("fake-skill-item"),
      });
      return { ok: true, value: { turnId } };
    },
  };
  writeRequest(fixture.desktopInput, {
    id: 4,
    method: "codexhost/thread/command/execute",
    params: { threadId, commandId: "fake.skill.render", arguments: { text: "a.html" } },
  });
  await expect(
    fixture.collector.waitFor((message) => requestId(message, 4)),
  ).resolves.toMatchObject({ result: { accepted: true } });
  // and skills/inspect now returns the fake skill
  await stopFixture(fixture);
});

it("rejects command execution absent from both catalogs", async () => {
  // execute with commandId "fake.ghost" against the session above → rpcError -32078,
  // and assert session.skills.execute was never called.
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run --config tests/vitest.config.js packages/host-runtime/test/app-server-host.test.ts` → unknown-method error for `skills/inspect`.

- [ ] **Step 3: Implement.** Route table addition after :756:

```ts
if (request.method === "codexhost/thread/skills/inspect") {
  await this.#inspectThreadSkills(request);
  continue;
}
```

`#inspectThreadSkills` is `#inspectThreadCommands` with `session.commands` → `session.skills`; when `resolution.kind !== "external" || !resolution.thread.session.skills` respond `{ result: { commands: [] } }` (empty catalog, not error — Harness-neutral contract).

In `#executeThreadCommand`, after the existing `commands.list()` membership check fails, consult skills before rejecting:

```ts
let capability: HarnessCommandCapability | undefined = commands;
let listed = await commands.list();
// ...existing membership check preserved...
if (!matched) {
  const skills = thread.session.skills;
  if (!skills) { /* existing -32078 rejection for unknown command */ }
  listed = await skills.list();
  if (!listed.ok) { await this.#writer.json(rpcError(request, -32078, listed.error.message)); return; }
  if (!listed.value.commands.some(({ id }) => id === params.data.commandId)) {
    await this.#writer.json(rpcError(request, -32078,
      `External Harness does not expose command '${params.data.commandId}'`));
    return;
  }
  capability = skills;
}
await this.#startExternalCommand(request, thread, capability, params.data.commandId, …);
```

Concretely: `#startExternalCommand` (:2070) gains a `capability: HarnessCommandCapability` parameter replacing its internal `const commands = thread.session.commands` read (:2079-2085); its null-commands error moves to the caller's existing `!commands && !skills` branch (error text "External Harness does not expose commands" preserved for the no-capability case).

- [ ] **Step 4: Text-turn interception joins both catalogs.** In the `turn/start` handler (:2995-3020), the block that sorts `thread.session.commands.list()` by invocation length and matches `text` — extract the catalog-matching into a local loop over `[commands, skills]` capabilities in that order (static commands win ties), and pass the matched capability's ID plus `catalog` to `#startExternalCommand` exactly as today (`"turn"` responseKind). Command IDs stay globally unique across the two catalogs, so a `matched.id` from skills executes correctly through the Adapter's `claude.skill.` dispatch (Task 2). Test: send `thread/start` + `turn/start` with text `/fake.render a.html` against the Task-3 fixture session (`fake.skill.render`, invocation `/render` — adjust the text to the fixture's invocation) and assert it executes via `session.skills.execute` and never forwards raw text; plus a negative case for a text matching no catalog entry (must still flow to `turn.start` as ordinary input).

- [ ] **Step 5: Run tests** (same as Step 2, plus the new interception tests) → PASS. Then `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
npm run format
git add packages/host-runtime
git commit -m "feat: route skill inspection and execution through the Host command surface"
```

---

### Task 4: Renderer Skills control

**Files:**
- Create: `packages/renderer-extension/src/renderer-harness-skill-control.ts`
- Modify: `packages/renderer-extension/src/renderer-harness-localization.ts`
- Modify: `packages/renderer-extension/src/renderer-model-client.ts` (:53 method const, :105-106 interface, :174-181 impl, :229 exports)
- Modify: `packages/renderer-extension/src/versioned-renderer-adapter.ts` (:1006-1009 pass-through)
- Modify: `packages/renderer-extension/src/renderer-composer-dom.ts` (:94 control type, :599-660 mount, :503-518 placement, :736 locale, :750 dispose)
- Modify: `packages/renderer-extension/src/renderer-binding-probe.ts` (:737-778 refresh/execute patterns, :2013 mount args, :962 & :2095 refresh triggers, :2289 onKeyDown)
- Test: `packages/renderer-extension/test/renderer-harness-skill-control.test.ts` (new), update `renderer-model-client.test.ts` and `renderer-harness-command-control.test.ts`-style localization tests

**Interfaces:**
- Consumes: Task 3's `codexhost/thread/skills/inspect`; existing `codexhost/thread/command/execute` accepts `{ threadId, commandId, arguments?: { text } }`.
- Produces:

```ts
// renderer-harness-skill-control.ts
export interface RendererHarnessSkillControl {
  readonly root: HTMLElement;
  setSkills(skills: readonly HarnessCommandDescriptor[]): void;
  setExecuting(commandId: string | null): void;
  setLocale(locale: RendererSettingsLocale): void;
  placeBefore(reference: Element | null): boolean;
  open(): void;                       // no-op when empty/executing (same gate as command control :225)
  hasSkills(): boolean;
  close(): void;
  dispose(): void;
}
export function mountRendererHarnessSkillControl(
  parent: Element,
  anchor: Element | null,
  onSelectSkill: (skill: HarnessCommandDescriptor, argument: string | undefined) => void,
): RendererHarnessSkillControl;

// renderer-model-client.ts addition
export const THREAD_SKILLS_INSPECT_METHOD = "codexhost/thread/skills/inspect";
inspectThreadSkills(input: ThreadCommandsInspectParams): Promise<HarnessCommandCatalog>;
```

- [ ] **Step 1: Localization.** In `renderer-harness-localization.ts`, extend `RendererHarnessMessages` with `readonly skills: string; readonly filterSkills: string; readonly back: string;` and values: EN `skills: "Skills"`, `filterSkills: "Filter skills"`, `back: "Back"`; zh-CN `skills: "技能"`, `filterSkills: "过滤技能"`, `back: "返回"` (the message function is a 2-locale ternary, zh-CN vs everything-else-English, :83-85 — no Korean set exists here despite the README's three-doc-language claim). Reuse `rendererHarnessCommandPresentation` unchanged for entries (skills labels/descriptions are native strings; no per-command zh mapping table).

- [ ] **Step 2: Write the failing DOM tests** in the new `renderer-harness-skill-control.test.ts` (jsdom pattern: copy the setup style used by `renderer-fork-control.test.ts` / `renderer-credits-control.test.ts` in the same directory):

```ts
// Required assertions, one `it` each:
// - mountRendererHarnessSkillControl hides root when setSkills([]) and hasSkills() is false
// - setSkills([textSkill, noneSkill]) shows root, trigger aria-expanded toggles on click
// - open() populates menu items with invocation + description
// - typing in the filter input narrows items by name OR description (case-insensitive)
// - clicking an argumentMode:"none" item calls onSelectSkill(item, undefined) and closes
// - clicking an argumentMode:"text" item switches to the argument phase: header shows the
//   invocation, an <input> is focused, Enter calls onSelectSkill(item, input.value.trim()),
//   Escape returns to the list phase without calling onSelectSkill
// - setExecuting("claude.skill.x") ignores further item clicks
// - Escape closes the popover; outside pointerdown closes it (mirror the command control's
//   scheduleClose/close semantics, renderer-harness-command-control.ts:229-247)
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run --config tests/vitest.config.js packages/renderer-extension/test/renderer-harness-skill-control.test.ts`.

- [ ] **Step 4: Implement `renderer-harness-skill-control.ts`.** Structure follows `renderer-harness-command-control.ts` line-for-line where possible — same attributes pattern (`data-codexhost-harness-skill-control` / `data-codexhost-harness-skill-menu`), same menu width constants, same trigger/menu/schedule-close machinery, `CONTROL_ATTRIBUTE` root hidden by `skills.length === 0` (:348-351 equivalent). Differences only:

- Header row of the list phase contains a filter `<input>` (role `searchbox`, `aria-label` = `messages.filterSkills`, full width, 6px padding, `borderRadius 6`, `background rgba(127,127,127,0.08)`, `color inherit`, `font 13px/18px system-ui`). Filtering predicate: `term === "" || (item.invocation + " " + presentation.label + " " + presentation.description).toLowerCase().includes(term)`.
- Argument phase for `argumentMode === "text"`: replaces menu children with a back affordance (`← ${messages.back}`), an invocation header (`/${name} ${argumentHintShown ? "" : ""}` — use `command.invocation` as-is), and one argument `<input>` (same style as filter input). `Enter` (no shift) → `onSelectSkill(command, value.trim() || undefined)`; `Escape` → back to list phase (do not close); focus on mount via `queueMicrotask`.
- `open()` public wrapper calls the internal `open(true)`; `hasSkills()` returns `skills.length > 0`.
- Trigger icon: reuse `commandIcon()`'s SVG pattern with a distinct glyph (sparkle/book style — any 1024-viewBox path set you copy from the existing file's constants; do not import new icon libraries). Trigger `aria-label`/title = `messages.skills`; add i18n like `harnessCommands` (:18/:32 style keys reuse `messages.skills`).
- Keyboard nav inside the list: identical `items`/`activeIndex` machinery (focusActive, arrow keys) copied structurally — filter input Escape→blur, second Escape→close.

- [ ] **Step 5: Client + adapter plumbing.** In `renderer-model-client.ts`: add the method const next to :53, add `inspectThreadSkills` to the interface (:105) and an implementation copied from `inspectThreadCommands` (:174-180) swapping schema → same `threadCommandsInspectParamsSchema`/`harnessCommandCatalogSchema` and method → `THREAD_SKILLS_INSPECT_METHOD`; export alongside (:229). Mirror in `versioned-renderer-adapter.ts` (:1006-1007 style). Update `renderer-model-client.test.ts` with one test asserting the request method + schema parse, following existing `inspectThreadCommands` coverage in that file.

- [ ] **Step 6: Composer mount.** `renderer-composer-dom.ts`:
- `ComposerAgentControl` (:94 area): `harnessSkills: RendererHarnessSkillControl;`.
- `mountComposerAgentControl` (:599): new final parameter `onSelectSkill: (skill: HarnessCommandDescriptor, argument: string | undefined) => void`; after the `harnessCommands` mount (:630-634):

```ts
const harnessSkills = mountRendererHarnessSkillControl(
  toolbar ?? composer,
  harnessCommands.root,
  onSelectSkill,
);
```

Verified: `mountRendererHarnessCommandControl` is already 4-param `(parent, insertBefore, onCommandSelected, initialLocale = "en")` (control file :134-139); the composer call site passes 3 args and relies on the later `setLocale` render pass — do the same for skills. The command control's mount has an `insertBefore?.parentElement === parent` guard (:176); mirror it in the skill control's mount. Popover menus are body-appended with `position: fixed` (:162-168), so DOM sibling order never affects stacking.

Add `harnessSkills` to the control literal (:657 area, next to `harnessCommands`).
- Placement (:517): replace the single chain line with:

```ts
if (usagePositionChanged) {
  control.harnessSkills.placeBefore(control.usage.root);
  control.harnessCommands.placeBefore(control.harnessSkills.root);
}
```

yielding `[commands][skills][usage]`.
- Locale (:736): `control.harnessSkills.setLocale(locale);` next to the commands call. Dispose (:750): `control.harnessSkills.dispose();`.

- [ ] **Step 7: Probe wiring** in `renderer-binding-probe.ts`:
- `MountedComposer` record: add `skillCatalogVersion = 0;` style bookkeeping only if needed for the stale-guard; the stale-guard itself copies `refreshCommands` (:737-758) verbatim with `inspectThreadSkills` → `control.harnessSkills.setSkills(...)`, same disposal/threadId/agent guards, and bump a `refreshSkills(generation)` counter if `MountedComposer` has one for commands (mirror exactly).
- `executeSkill(mounted, skill, argument)` copies `executeCommand` (:760-778): `setExecuting(skill.id)`, `modelControl.executeThreadCommand({ threadId, commandId: skill.id, ...(argument === undefined ? {} : { arguments: { text: argument } }) })`, finally `setExecuting(null)`.
- Mount site (:2013-2040): add the extra callback argument after the existing `(command) => { void executeCommand(mounted, command); }`: `(skill, argument) => { const mounted = mountedByComposer.get(composer); if (!composer.isConnected || !mounted) return; void executeSkill(mounted, skill, argument); }`.
- Refresh triggers (:962 and :2095): where `void refreshCommands(mounted)` appears, add `void refreshSkills(mounted)` on the same guard.
- Shortcut at the top of `onKeyDown` (:2289, before the first existing branch):

```ts
if (
  (event.metaKey || event.ctrlKey) &&
  event.shiftKey &&
  event.key.toLowerCase() === "s" &&
  !event.isComposing
) {
  const composer = composerForTarget(event.target);
  const mounted = composer ? mountedByComposer.get(composer) : undefined;
  if (mounted && mounted.control.harnessSkills.hasSkills()) {
    blockEvent(event);
    mounted.control.harnessSkills.open();
  }
  return;
}
```

- [ ] **Step 8: Run renderer suites + typecheck**

```bash
npm run build:typescript
npx vitest run --config tests/vitest.config.js packages/renderer-extension
npm run typecheck
```

- [ ] **Step 9: Commit**

```bash
npm run format
git add packages/renderer-extension
git commit -m "feat: add Composer Skills control with search and shortcut"
```

---

### Task 5: Docs, full gate, smoke test, real-device checklist

**Files:**
- Modify: `docs/harness-command-integration.md` (Current examples section :74-95). README.md's 功能状态 table is left to the product owner.

**Interfaces:**
- Consumes: all tasks above.
- Produces: nothing downstream.

- [ ] **Step 1: Doc update.** In `docs/harness-command-integration.md` after the "Current examples" block, add:

```markdown
## Skill catalog (Claude Code)

Harness Skills are a second, independent catalog: the Adapter enumerates them from the
Harness's native discovery surface (`supportedCommands()` filtered by the session's skill
list), never by scanning disk. Skills execute through the same `thread/command/execute`
Host route; the Host validates against the union of the Thread's Commands and Skills
catalogs. The Renderer presents them in a separate Composer Skills control — SKILL.md
files must still never be parsed or executed in the Renderer.
```

- [ ] **Step 2: Full local gate**

```bash
npm run typecheck
npm run lint
npm run test:typescript
git diff --check
```
Expected: all PASS. (`npm run check:rust` unchanged — no Rust touched; skip.)

- [ ] **Step 3: 1-2 trial smoke test before finishing** (per repo rule "Smoke Test First"): run `npm start`, attach Codex Desktop, pick a Claude Code Thread, send one ordinary message so the transport exists, then confirm the Skills button appears (given this machine has `~/.claude/skills`), select an `argumentMode: "none"` skill, and confirm a real Turn streams. If the button never appears, capture `session.skills.list()` failures from host logs before proceeding.

- [ ] **Step 4: Real-device verification checklist** (manual, record results in the PR description; fix inline only what the checklist proves broken):
1. Project skills: in a repo containing `.claude/skills/<demo>`, confirm `<demo>` appears in Skills (proves `settingSources` change works).
2. CLAUDE.md: ask "what does your project CLAUDE.md contain?" and confirm it answers (regression check for the settingSources behavior change called out in design.md Risks).
3. Text-argument skill: execute one with an argument via the popover; confirm the transcript shows `/<name> <arg>` — **if the raw `<command-name>` envelope text is rendered in the user bubble instead**, file the follow-up: extend `displayedUserText` (`packages/adapters/claude-code/src/claude-history.ts:72-76`) with a generic `<command-name>/x</command-name>` → `/x args` mapping fed by the session's known skill-name set, with a focused claude-history test. Do not implement speculatively.
4. Cancel mid-skill-Turn; approve a tool call the skill requests; confirm both behave like ordinary Turns.
5. `⌘/Ctrl+Shift+S` opens the popover from composer focus; does nothing on a Pi Thread.
6. Fork/resume the Thread; confirm skills reappear.

- [ ] **Step 5: Commit + finalize openspec checkboxes**

```bash
git add docs
git commit -m "docs: describe Harness skill catalog integration path"
```
Then tick the corresponding boxes in `openspec/changes/add-harness-skill-selection/tasks.md` (1.1-1.5 → Tasks 1-2 here; 2.1-2.4 → Tasks 2-3; 3.1-3.4 → Task 4; 4.x → this task; 4.6 doc line included) and commit `docs: record skill selection implementation progress`.

---

## Self-Review Notes (plan vs spec)

- `harness-skill-catalog` requirements: enumeration→Task 1; projection/ID-escape/conflict→Task 2; execution route→Tasks 2+3; `commands_changed` refresh→Task 1 (transport) + passive re-inspect→Task 4 refresh triggers; inspect RPC + non-Claude empty→Task 3; button/filter/shortcut/no-text-injection→Task 4. "MUST NOT scan disk" honored everywhere (transport cache only).
- `harness-command-capabilities` delta: disjoint catalogs (static parse path never sees skill IDs; skill path never sees static IDs); single execute RPC; union boundary validation; Pi/Codex isolation preserved by the existing per-session capability reads.
- Known deliberate simplifications: `aliases` ignored (design Open Question); popover refresh is passive (design Open Question); lazy `ensureTransport` inside `skills.list()` means the first inspect on a fresh Thread pays ~1 process spawn — flagged in Task 5 smoke step.
