import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import {
  harnessCommandCatalogSchema,
  hostTurnIdSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildLiveCommandCatalog } from "../src/acp-projection.js";
import type {
  AntigravityAcpEvent,
  AntigravityAcpTransportLike,
  AntigravityAcpTransportOptions,
  AntigravityOpenAcpSessionInput,
  AntigravitySessionEventHandler,
} from "../src/acp-types.js";
import { AntigravityAdapter, AntigravitySession } from "../src/antigravity-adapter.js";
import * as skillDiscovery from "../src/skill-discovery.js";
import {
  ANTIGRAVITY_COMMAND_CATALOG,
  findAntigravityCommandDescriptor,
  parseAndFormatAntigravityCommand,
} from "../src/slash-commands.js";

const turnId = hostTurnIdSchema.parse("turn-command");
const builtInNames = [
  "plan",
  "goal",
  "browser",
  "grill-me",
  "boost",
  "learn",
  "schedule",
  "compact",
  "help",
];

describe("Antigravity slash command catalog", () => {
  it("conforms to the public schema and includes the built-in commands", () => {
    expect(harnessCommandCatalogSchema.safeParse(ANTIGRAVITY_COMMAND_CATALOG).success).toBe(true);
    expect(ANTIGRAVITY_COMMAND_CATALOG.commands.map(({ invocation }) => invocation)).toEqual(
      builtInNames.map((name) => `/${name}`),
    );
    for (const command of ANTIGRAVITY_COMMAND_CATALOG.commands) {
      expect(command.id).toMatch(/^antigravity\./);
      expect(command.argumentMode).toBe("text");
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.description?.length).toBeGreaterThan(0);
    }
  });

  it.each(builtInNames)("resolves %s by ID, invocation and suffix", (name) => {
    const descriptor = findAntigravityCommandDescriptor(`antigravity.${name}`);
    expect(descriptor?.invocation).toBe(`/${name}`);
    expect(findAntigravityCommandDescriptor(`/${name}`)).toEqual(descriptor);
    expect(findAntigravityCommandDescriptor(name)).toEqual(descriptor);
  });

  it("does not resolve unknown commands", () => {
    expect(findAntigravityCommandDescriptor("unknown")).toBeUndefined();
    expect(parseAndFormatAntigravityCommand({ turnId, commandId: "unknown" })).toMatchObject({
      ok: false,
      error: { code: "unsupported", retryable: false },
    });
  });
});

describe("Antigravity command formatting", () => {
  it.each(builtInNames)("formats bare /%s without arguments", (name) => {
    expect(parseAndFormatAntigravityCommand({ turnId, commandId: name })).toMatchObject({
      ok: true,
      value: { prompt: `/${name}`, descriptor: { id: `antigravity.${name}` } },
    });
  });

  it.each([
    ["  refactor authentication  ", "/plan refactor authentication"],
    ["   ", "/plan"],
    ["", "/plan"],
  ])("trims argument text %j", (text, prompt) => {
    expect(
      parseAndFormatAntigravityCommand({ turnId, commandId: "/plan", arguments: { text } }),
    ).toMatchObject({
      ok: true,
      value: { prompt },
    });
  });

  const invalidArguments: JsonObject[] = [
    { text: 123 },
    { text: false },
    { text: ["not text"] },
    { text: {} },
    { text: "ok", extra: "unknown" },
  ];
  it.each(invalidArguments)("rejects invalid arguments %j", (arguments_) => {
    expect(
      parseAndFormatAntigravityCommand({ turnId, commandId: "plan", arguments: arguments_ }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
  });
});

describe("dynamic ACP slash commands", () => {
  const catalog = buildLiveCommandCatalog([{ name: "quota", description: "Quota" }]);

  it.each(["antigravity.quota", "/quota", "quota"])(
    "finds and formats %s from the live catalog",
    (commandId) => {
      expect(findAntigravityCommandDescriptor(commandId, catalog)?.invocation).toBe("/quota");
      expect(
        parseAndFormatAntigravityCommand(
          { turnId, commandId, arguments: { text: "  details  " } },
          catalog,
        ),
      ).toMatchObject({ ok: true, value: { prompt: "/quota details" } });
    },
  );

  it("does not resolve a live command against the default catalog", () => {
    expect(parseAndFormatAntigravityCommand({ turnId, commandId: "quota" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
  });

  it("honors a dynamic no-argument descriptor", () => {
    const noArgs = harnessCommandCatalogSchema.parse({
      commands: [
        { id: "antigravity.info", invocation: "/info", label: "Info", argumentMode: "none" },
      ],
    });
    expect(parseAndFormatAntigravityCommand({ turnId, commandId: "info" }, noArgs)).toMatchObject({
      ok: true,
      value: { prompt: "/info" },
    });
    expect(
      parseAndFormatAntigravityCommand(
        { turnId, commandId: "info", arguments: { text: "oops" } },
        noArgs,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });

  it("merges native commands without replacing built-ins or accepting invalid names", () => {
    const merged = buildLiveCommandCatalog([
      { name: "quota", description: "Quota" },
      { name: "/plan", description: "Duplicate" },
      { name: "quota", description: "Duplicate quota" },
      { name: "two words", description: "Invalid" },
      { name: "", description: "Empty" },
    ]);
    expect(merged.commands.filter(({ invocation }) => invocation === "/plan")).toEqual([
      findAntigravityCommandDescriptor("plan"),
    ]);
    expect(merged.commands.filter(({ invocation }) => invocation === "/quota")).toHaveLength(1);
    expect(findAntigravityCommandDescriptor("quota", merged)).toMatchObject({
      description: "Quota",
    });
    expect(merged.commands).toHaveLength(ANTIGRAVITY_COMMAND_CATALOG.commands.length + 1);
    expect(buildLiveCommandCatalog([])).toEqual(ANTIGRAVITY_COMMAND_CATALOG);
  });
});

describe("Antigravity live command skill filtering and readiness", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function makeWorkspace(): Promise<{ home: string; cwd: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-skills-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    const cwd = path.join(root, "repo", "packages", "app");
    await mkdir(path.join(root, "repo", ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });
    return { home, cwd };
  }

  async function writeSkill(root: string, dirName: string, frontmatter: string): Promise<void> {
    const dir = path.join(root, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# Body\n`, "utf8");
  }

  function createSessionTransport(availableCommands: Array<{ name: string; description: string }>) {
    return (options: AntigravityAcpTransportOptions): AntigravityAcpTransportLike => {
      let sessionId: string | null = null;
      let handler: AntigravitySessionEventHandler | null = null;
      const queued: AntigravityAcpEvent[] = [];
      return {
        get sessionId() {
          return sessionId;
        },
        skipPermissions: options.skipPermissions === true,
        isClosed: false,
        initialize: vi.fn(async (): Promise<InitializeResponse> => ({
          protocolVersion: 1,
          agentCapabilities: {},
        })),
        openSession: vi.fn(async (input: AntigravityOpenAcpSessionInput) => {
          sessionId = input.sessionId ?? randomUUID();
          queued.push({ type: "commands.update", commands: availableCommands });
          return {
            opened: {
              sessionId,
              configOptions: [],
              modes: { currentModeId: "default", availableModes: [] },
            },
          };
        }),
        setSessionEventHandler(next) {
          handler = next;
          if (handler) for (const event of queued.splice(0)) handler(event);
        },
        setMode: vi.fn(async () => undefined),
        setConfigOption: vi.fn(async () => []),
        prompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
        cancel: vi.fn(async () => undefined),
        closeSession: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
    };
  }

  it("filters discovered skills from agy ACP availableCommands while preserving native commands and same-name non-skill commands", async () => {
    const { home, cwd } = await makeWorkspace();
    const repoRoot = path.resolve(cwd, "..", "..");
    // Mirrors real agy acp entries: global, workspace ancestor, and agy builtin skills.
    await writeSkill(
      path.join(home, ".agents", "skills"),
      "lead-delegation",
      'name: lead-delegation\ndescription: >\n  以主导者身份把开发工作委派给其他 Agent，\n  用于"让 Pi 做"等委派场景。',
    );
    await writeSkill(
      path.join(home, ".agents", "skills"),
      "code-review",
      'name: code-review\ndescription: "Review changes or asks to \\"review since X\\"."',
    );
    await writeSkill(
      path.join(home, ".agents", "skills"),
      "grill-me",
      "name: grill-me\ndescription: A relentless interview to sharpen a plan or design.",
    );
    await writeSkill(
      path.join(home, ".agents", "skills"),
      "teamwork",
      "name: teamwork\ndescription: User-defined teamwork skill description.",
    );
    await writeSkill(
      path.join(repoRoot, ".agents", "skills"),
      "codexhost-code-review",
      "name: codexhost-code-review\ndescription: 审查 codexhost PR。",
    );
    await writeSkill(
      path.join(home, ".gemini", "antigravity-cli", "builtin", "skills"),
      "native_swarm",
      "name: swarm\ndescription: >-\n  (Preview & Quota Heavy) Run a swarm in parallel.",
    );

    const adapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      createTransport: createSessionTransport([
        { name: "plan", description: "Plan carefully before executing a task." },
        { name: "grill-me", description: "Interview me to align on a plan." },
        {
          name: "teamwork",
          description: "Invoke a team of agents to autonomously tackle large projects.",
        },
        {
          name: "lead-delegation",
          description: '以主导者身份把开发工作委派给其他 Agent， 用于"让 Pi 做"等委派场景。',
        },
        {
          name: "code-review",
          description: 'Review changes or asks to "review since X".',
        },
        {
          name: "grill-me",
          description: "A relentless interview to sharpen a plan or design.",
        },
        {
          name: "teamwork",
          description: "User-defined teamwork skill description.",
        },
        {
          name: "codexhost-code-review",
          description: "审查 codexhost PR。",
        },
        {
          name: "swarm",
          description: "(Preview & Quota Heavy) Run a swarm in parallel.",
        },
      ]),
    });
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = opened.value as AntigravitySession;
    try {
      // Cold start before transport opens: built-ins only, not marked live yet.
      const cold = await session.commands.list();
      expect(cold.ok).toBe(true);
      if (cold.ok) expect(cold.value.source).toBeUndefined();

      await session.initialize();
      const live = await session.commands.list();
      expect(live.ok).toBe(true);
      if (!live.ok) return;
      const invocations = live.value.commands.map(({ invocation }) => invocation);
      expect(live.value.source).toBe("live");
      expect(invocations).toContain("/plan");
      expect(invocations).toContain("/grill-me");
      // Same-name genuine native command is preserved when its description differs from the skill.
      expect(invocations).toContain("/teamwork");
      expect(
        live.value.commands.find(({ invocation }) => invocation === "/teamwork")?.description,
      ).toBe("Invoke a team of agents to autonomously tackle large projects.");
      // Discovered skills are excluded from native commands.
      expect(invocations).not.toContain("/lead-delegation");
      expect(invocations).not.toContain("/code-review");
      expect(invocations).not.toContain("/codexhost-code-review");
      expect(invocations).not.toContain("/swarm");

      // Attempting to execute a filtered skill as a native command is rejected.
      const rejected = await session.commands.execute({
        turnId,
        commandId: "antigravity.lead-delegation",
      });
      expect(rejected).toMatchObject({ ok: false, error: { code: "unsupported" } });
    } finally {
      await session.close();
      await adapter.close();
    }
  });

  it("marks the command catalog live even when filtering leaves only built-in commands", async () => {
    const { home, cwd } = await makeWorkspace();
    await writeSkill(
      path.join(home, ".agents", "skills"),
      "lead-delegation",
      "name: lead-delegation\ndescription: Delegate work cleanly.",
    );

    const adapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      createTransport: createSessionTransport([
        { name: "plan", description: "Plan carefully before executing a task." },
        { name: "compact", description: "Compact now." },
        { name: "lead-delegation", description: "Delegate work cleanly." },
      ]),
    });
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = opened.value as AntigravitySession;
    try {
      await session.initialize();
      const live = await session.commands.list();
      expect(live.ok).toBe(true);
      if (!live.ok) return;
      expect(live.value.source).toBe("live");
      expect(live.value.commands).toEqual(ANTIGRAVITY_COMMAND_CATALOG.commands);
    } finally {
      await session.close();
      await adapter.close();
    }
  });

  it("parses YAML comments, escapes, and quoted continuations while conservatively ignoring invalid/empty-description SKILL.md files", async () => {
    const { home, cwd } = await makeWorkspace();
    const skillsRoot = path.join(home, ".agents", "skills");
    // Valid YAML with inline comments, \xNN escapes, and double-quoted continuation.
    await writeSkill(
      skillsRoot,
      "yaml-edge",
      [
        "name: yaml-edge # inline comment",
        'description: "Alpha \\x42',
        '  Beta" # trailing comment',
      ].join("\n"),
    );
    // Missing frontmatter -> must not be treated as exclusion evidence.
    await mkdir(path.join(skillsRoot, "no-frontmatter"), { recursive: true });
    await writeFile(path.join(skillsRoot, "no-frontmatter", "SKILL.md"), "# Plain doc\n", "utf8");
    // Invalid YAML frontmatter -> must not be treated as exclusion evidence.
    await writeSkill(skillsRoot, "broken-yaml", "name: broken-yaml\ndescription: [unterminated");
    // Valid YAML but empty description -> must not exclude a descriptionless dynamic command.
    await writeSkill(skillsRoot, "empty-desc", 'name: empty-desc\ndescription: "   "');
    // Oversized (> 64 KiB) frontmatter -> truncated, must not exclude.
    await mkdir(path.join(skillsRoot, "huge-fm"), { recursive: true });
    await writeFile(
      path.join(skillsRoot, "huge-fm", "SKILL.md"),
      `---\nname: huge-fm\ndescription: "${"a".repeat(70_000)}"\n---\n`,
      "utf8",
    );

    const discoveredSkills = await skillDiscovery.discoverAntigravitySkills({ cwd, home });
    expect(discoveredSkills.get("yaml-edge")?.has("Alpha B Beta")).toBe(true);
    expect(discoveredSkills.has("no-frontmatter")).toBe(false);
    expect(discoveredSkills.has("broken-yaml")).toBe(false);
    expect(discoveredSkills.has("empty-desc")).toBe(false);
    expect(discoveredSkills.has("huge-fm")).toBe(false);

    const catalog = buildLiveCommandCatalog(
      [
        { name: "yaml-edge", description: "Alpha B Beta" },
        { name: "no-frontmatter", description: "" },
        { name: "broken-yaml", description: "" },
        { name: "empty-desc", description: "" },
        { name: "huge-fm", description: "" },
      ],
      { discoveredSkills },
    );
    const invocations = catalog.commands.map(({ invocation }) => invocation);
    expect(invocations).not.toContain("/yaml-edge");
    expect(invocations).toContain("/no-frontmatter");
    expect(invocations).toContain("/broken-yaml");
    expect(invocations).toContain("/empty-desc");
    expect(invocations).toContain("/huge-fm");
  });

  it("ignores special files (writerless FIFO) and oversized config files without blocking", async () => {
    const { home, cwd } = await makeWorkspace();
    const skillsRoot = path.join(home, ".agents", "skills");
    await writeSkill(skillsRoot, "real-skill", "name: real-skill\ndescription: Real skill.");
    // Oversized skills.json (> 256 KiB) must be skipped safely.
    const configDir = path.join(home, ".gemini", "config");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "skills.json"),
      JSON.stringify({ entries: [{ path: "x".repeat(300_000) }] }),
      "utf8",
    );

    if (process.platform !== "win32") {
      const fifoSkillDir = path.join(skillsRoot, "fifo-skill");
      await mkdir(fifoSkillDir, { recursive: true });
      execFileSync("mkfifo", [path.join(fifoSkillDir, "SKILL.md")]);
      const repoAgents = path.join(path.resolve(cwd, "..", ".."), ".agents");
      await mkdir(repoAgents, { recursive: true });
      execFileSync("mkfifo", [path.join(repoAgents, "skills.json")]);
    }

    const discovered = await skillDiscovery.discoverAntigravitySkills({ cwd, home });
    expect(discovered.get("real-skill")?.has("Real skill.")).toBe(true);
    expect(discovered.has("fifo-skill")).toBe(false);
  });

  it("executes built-in commands immediately without waiting for an in-flight skill scan", async () => {
    const { home, cwd } = await makeWorkspace();
    const scanDeferred = Promise.withResolvers<skillDiscovery.DiscoveredAntigravitySkills>();
    vi.spyOn(skillDiscovery, "discoverAntigravitySkills").mockReturnValue(scanDeferred.promise);

    const promptSpy = vi.fn(async () => ({ stopReason: "end_turn" as const }));
    const adapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      createTransport: (options) => ({
        ...createSessionTransport([{ name: "quota", description: "Quota" }])(options),
        prompt: promptSpy,
      }),
    });
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = opened.value as AntigravitySession;
    try {
      await session.initialize();
      const result = await session.commands.execute({
        turnId,
        commandId: "antigravity.compact",
      });
      expect(result).toEqual({ ok: true, value: { turnId } });
      await vi.waitFor(() => {
        expect(promptSpy).toHaveBeenCalledWith(
          [{ type: "text", text: "/compact" }],
          expect.anything(),
        );
      });
    } finally {
      scanDeferred.resolve(new Map());
      await session.close();
      await adapter.close();
    }
  });

  it("wakes waiters immediately with B's catalog when B finishes while older scan A stays unsettled", async () => {
    const { home, cwd } = await makeWorkspace();
    const scanA = Promise.withResolvers<skillDiscovery.DiscoveredAntigravitySkills>();
    const scanB = Promise.withResolvers<skillDiscovery.DiscoveredAntigravitySkills>();
    vi.spyOn(skillDiscovery, "discoverAntigravitySkills")
      .mockReturnValueOnce(scanA.promise)
      .mockReturnValueOnce(scanB.promise);

    let emitEvent: AntigravitySessionEventHandler | null = null;
    const adapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      createTransport: (options) => {
        const base = createSessionTransport([{ name: "alpha", description: "Stale command A" }])(
          options,
        );
        return {
          ...base,
          setSessionEventHandler(handler) {
            emitEvent = handler;
            base.setSessionEventHandler(handler);
          },
        };
      },
    });
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = opened.value as AntigravitySession;
    try {
      await session.initialize();
      // Callers start waiting while update A is still scanning.
      const listPromise = session.commands.list();
      const executeStalePromise = session.commands.execute({
        turnId,
        commandId: "antigravity.alpha",
      });

      // Update B arrives and finishes while update A NEVER resolves.
      emitEvent?.({
        type: "commands.update",
        commands: [{ name: "beta", description: "Fresh command B" }],
      });
      scanB.resolve(new Map());

      // Waiters that originally waited on A must resolve immediately with B's catalog.
      const listed = await listPromise;
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        const invocations = listed.value.commands.map(({ invocation }) => invocation);
        expect(invocations).toContain("/beta");
        expect(invocations).not.toContain("/alpha");
      }
      // Execution waiting across A->B must reject the revoked command A without waiting for A.
      await expect(executeStalePromise).resolves.toMatchObject({
        ok: false,
        error: { code: "unsupported" },
      });

      // Even if A settles later, it must not overwrite B's catalog.
      scanA.resolve(new Map());
      await Promise.resolve();
      const afterLateA = await session.commands.list();
      expect(afterLateA.ok).toBe(true);
      if (afterLateA.ok) {
        const invocations = afterLateA.value.commands.map(({ invocation }) => invocation);
        expect(invocations).toContain("/beta");
        expect(invocations).not.toContain("/alpha");
      }
    } finally {
      scanA.resolve(new Map());
      await session.close();
      await adapter.close();
    }
  });

  it("resets command catalog and wakes waiters on initialize setMode rollback and on session close", async () => {
    const { home, cwd } = await makeWorkspace();
    const scanDeferred = Promise.withResolvers<skillDiscovery.DiscoveredAntigravitySkills>();
    vi.spyOn(skillDiscovery, "discoverAntigravitySkills").mockReturnValue(scanDeferred.promise);

    // 1. setMode fails during initialize() after commands.update arrived: rollback must
    // wake pending commands.list() with static built-ins (no source="live") and never hang.
    let listDuringRollback: Promise<unknown> | undefined;
    const rollbackAdapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      createTransport: (options) => ({
        ...createSessionTransport([{ name: "quota", description: "Quota" }])(options),
        setMode: vi.fn(async () => {
          // Caller begins listing commands while scan is still pending and setMode is failing.
          listDuringRollback = rollbackSession.commands.list();
          throw new Error("mode rejected");
        }),
      }),
    });
    const rollbackOpened = await rollbackAdapter.open({
      kind: "create",
      cwd,
      permissionModeId: "plan" as never,
    });
    expect(rollbackOpened.ok).toBe(true);
    if (!rollbackOpened.ok) return;
    const rollbackSession = rollbackOpened.value as AntigravitySession;
    try {
      await expect(rollbackSession.initialize()).rejects.toThrow("mode rejected");
      expect(listDuringRollback).toBeDefined();
      await expect(listDuringRollback).resolves.toEqual({
        ok: true,
        value: ANTIGRAVITY_COMMAND_CATALOG,
      });
      // Late scan resolution after rollback must not leak a live catalog onto the torn-down session.
      scanDeferred.resolve(new Map());
      await Promise.resolve();
      const afterRollback = await rollbackSession.commands.list();
      expect(afterRollback).toEqual({ ok: true, value: ANTIGRAVITY_COMMAND_CATALOG });
    } finally {
      await rollbackSession.close();
      await rollbackAdapter.close();
    }

    // 2. Closing a Session (both while scanning and after live catalog loaded) must never
    // return a stale source="live" catalog that could pollute Host cache.
    vi.restoreAllMocks();
    const pendingCloseScan = Promise.withResolvers<skillDiscovery.DiscoveredAntigravitySkills>();
    vi.spyOn(skillDiscovery, "discoverAntigravitySkills").mockReturnValueOnce(
      pendingCloseScan.promise,
    );
    const closeAdapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      createTransport: createSessionTransport([{ name: "quota", description: "Quota" }]),
    });
    const closeOpened = await closeAdapter.open({ kind: "create", cwd });
    expect(closeOpened.ok).toBe(true);
    if (!closeOpened.ok) return;
    const closeSession = closeOpened.value as AntigravitySession;
    try {
      await closeSession.initialize();
      const pendingList = closeSession.commands.list();
      await closeSession.close();
      await expect(pendingList).resolves.toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
      await expect(closeSession.commands.list()).resolves.toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
    } finally {
      pendingCloseScan.resolve(new Map());
      await closeAdapter.close();
    }
  });

  it("prioritizes standard .agents/skills roots ahead of large plugin trees under the shared budget", async () => {
    const { home, cwd } = await makeWorkspace();
    const repoRoot = path.resolve(cwd, "..", "..");
    await writeSkill(
      path.join(repoRoot, ".agents", "skills"),
      "lead-delegation",
      "name: lead-delegation\ndescription: Standard workspace skill.",
    );
    // Create 300 plugin skill directories (> MAX_TOTAL_ROOTS=256) to verify atomic cap & priority.
    const pluginsRoot = path.join(repoRoot, ".agents", "plugins");
    await Promise.all(
      Array.from({ length: 300 }, async (_, index) => {
        await writeSkill(
          path.join(pluginsRoot, `plugin-${String(index).padStart(3, "0")}`, "skills"),
          `plugin-skill-${index}`,
          `name: plugin-skill-${index}\ndescription: Plugin skill ${index}.`,
        );
      }),
    );

    const discovered = await skillDiscovery.discoverAntigravitySkills({ cwd, home });
    expect(discovered.get("lead-delegation")?.has("Standard workspace skill.")).toBe(true);
    // Shared root cap (256) must bound total plugin skill roots discovered atomically.
    expect(discovered.size).toBeLessThanOrEqual(256);
  });

  it("still inspects SKILL.md for already-enumerated candidates when the entry budget is reached", async () => {
    const { home, cwd } = await makeWorkspace();
    const skillsRoot = path.join(path.resolve(cwd, "..", ".."), ".agents", "skills");
    await writeSkill(skillsRoot, "skill-a", "name: skill-a\ndescription: Skill A.");
    await writeSkill(skillsRoot, "skill-b", "name: skill-b\ndescription: Skill B.");
    await writeSkill(skillsRoot, "skill-c", "name: skill-c\ndescription: Skill C.");

    // Budget hits exact limit (2 entries) right while enumerating skillsRoot;
    // the 2 already-enumerated candidate directories must still have SKILL.md read.
    const discovered = await skillDiscovery.discoverAntigravitySkills({
      cwd,
      home,
      maxEntries: 2,
    });
    expect(discovered.size).toBe(2);
  });
});
