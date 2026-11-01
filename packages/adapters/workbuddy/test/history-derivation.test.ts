import type * as FsPromises from "node:fs/promises";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodeBuddyClientFactory,
  CodeBuddyChildObserver,
  codeBuddyCanonicalCwd,
  codeBuddyNativeHistory,
  deriveCodeBuddySession,
  modelRef,
  nativeHistoryRows,
  snapshotFromHistory,
} from "@codexhost/adapter-codebuddy";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { WORKBUDDY_RUNTIME_PROFILE } from "../src/common.js";
import { WorkBuddyAdapter } from "../src/workbuddy-adapter.js";

const simulatedWindows = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const info = await fs.lstat(...args);
      if (simulatedWindows.enabled && typeof info.mode === "number") info.mode |= 0o077;
      return info;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  simulatedWindows.enabled = false;
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sourceRef = nativeSessionRefSchema.parse({
  harnessId: "workbuddy",
  nativeSessionId: "source",
  formatVersion: 1,
});
const checkpoint = nativeCheckpointRefSchema.parse({
  harnessId: "workbuddy",
  nativeSessionId: "source",
  checkpointId: "u1",
  formatVersion: 1,
});
const configOptions = [
  {
    id: "model",
    currentValue: "native/model",
    options: [{ value: "native/model", name: "Native Model" }],
  },
  {
    id: "mode",
    currentValue: "default",
    options: ["default", "plan", "fullAccess"].map((value) => ({ value, name: value })),
  },
  {
    id: "thought_level",
    currentValue: "low",
    options: ["low", "high"].map((value) => ({ value, name: value })),
  },
];

const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

async function setup(
  options: {
    sameCwd?: boolean;
    sourceRace?: boolean;
    badRewind?: boolean;
    cleanupFailure?: boolean;
    withChild?: boolean;
    nativeCopiesChild?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbuddy-derive-"));
  roots.push(root);
  const sourceCwd = path.join(root, "Source.Project");
  const targetCwd = options.sameCwd ? sourceCwd : path.join(root, "Target.Worktree 项目");
  await Promise.all([mkdir(sourceCwd), ...(options.sameCwd ? [] : [mkdir(targetCwd)])]);
  const environment = { WORKBUDDY_CONFIG_DIR: path.join(root, "config") };
  const retained = [
    {
      id: "u1",
      type: "message",
      role: "user",
      content: "one",
      sessionId: "source",
      cwd: sourceCwd,
    },
    {
      id: "a1",
      parentId: "u1",
      type: "message",
      role: "assistant",
      content: "answer",
      status: "completed",
      sessionId: "source",
      cwd: sourceCwd,
    },
    {
      id: "tool",
      parentId: "a1",
      type: "function_call",
      name: "Bash",
      callId: "call",
      arguments: { command: "cat relative.txt" },
      sessionId: "source",
      cwd: sourceCwd,
    },
    {
      id: "result",
      parentId: "tool",
      type: "function_call_result",
      callId: "call",
      output: "file",
      status: "completed",
      sessionId: "source",
      cwd: sourceCwd,
    },
    ...(options.withChild
      ? [
          {
            id: "agent-tool",
            parentId: "result",
            type: "function_call",
            name: "Agent",
            callId: "agent-call",
            arguments: { prompt: "inspect" },
            sessionId: "source",
            cwd: sourceCwd,
          },
          {
            id: "agent-result",
            parentId: "agent-tool",
            type: "function_call_result",
            name: "Agent",
            callId: "agent-call",
            output: "done\n\n[Agent ID: agent-child]",
            status: "completed",
            providerData: {
              toolResult: {
                subAgent: { sessionId: "agent-child", lastId: "child-a1" },
              },
            },
            sessionId: "source",
            cwd: sourceCwd,
          },
        ]
      : []),
  ];
  const original = [
    ...retained,
    {
      id: "u2",
      parentId: options.withChild ? "agent-result" : "result",
      type: "message",
      role: "user",
      content: "two",
      sessionId: "source",
      cwd: sourceCwd,
    },
    {
      id: "a2",
      parentId: "u2",
      type: "message",
      role: "assistant",
      content: "last",
      status: "completed",
      sessionId: "source",
      cwd: sourceCwd,
    },
  ];
  const contents = jsonl(original);
  // Build native fixture paths independently of the adapter's history path implementation.
  const rootDirectory = codeBuddyCanonicalCwd(root)
    .split(path.sep)
    .filter(Boolean)
    .join("-")
    .replace(/:/gu, "");
  const file = (cwd: string, id: string) =>
    path.join(
      environment.WORKBUDDY_CONFIG_DIR,
      "projects",
      `${rootDirectory}-${cwd === sourceCwd ? "Source.Project" : "Target.Worktree 项目"}`,
      `${id}.jsonl`,
    );
  const childFile = (cwd: string, parentId: string, childId = "agent-child") =>
    path.join(path.dirname(file(cwd, parentId)), parentId, "subagents", `${childId}.jsonl`);
  const childPrefixContents = jsonl([
    {
      id: "child-u1",
      type: "message",
      role: "user",
      content: "inspect",
      sessionId: "native-child",
      cwd: sourceCwd,
    },
    {
      id: "child-a1",
      parentId: "child-u1",
      type: "message",
      role: "assistant",
      content: "result",
      status: "completed",
      sessionId: "native-child",
      cwd: sourceCwd,
    },
  ]);
  const childContents =
    childPrefixContents +
    jsonl([
      {
        id: "child-after-checkpoint",
        parentId: "child-a1",
        type: "message",
        role: "user",
        content: "must not be inherited",
        sessionId: "native-child",
        cwd: sourceCwd,
      },
    ]);
  await mkdir(path.dirname(file(sourceCwd, "source")), { recursive: true });
  await writeFile(file(sourceCwd, "source"), contents);
  if (options.withChild) {
    await mkdir(path.dirname(childFile(sourceCwd, "source")), { recursive: true });
    await writeFile(childFile(sourceCwd, "source"), childContents);
  }
  const copy = vi.fn(async (cwd: string, source: string, target: string) => {
    const copied = await readFile(file(cwd, source), "utf8");
    await mkdir(path.dirname(file(cwd, target)), { recursive: true });
    await writeFile(
      file(cwd, target),
      copied + jsonl([{ type: "session-meta", sessionId: target }]),
    );
  });
  const prompt = vi.fn();
  const rollback = vi.fn();
  const opens: Array<{ cwd: string; sessionId: string }> = [];
  let temporaryId = "";
  let currentDerivedId = "";
  let forkOrdinal = 0;
  const factory: CodeBuddyClientFactory = (context) => ({
    removeCopy: async () => {
      if (!temporaryId) throw new Error("missing owned copy");
      if (options.cleanupFailure) await chmod(path.dirname(file(targetCwd, temporaryId)), 0o500);
      await rm(file(targetCwd, temporaryId), { force: true });
    },
    initialize: async () => ({}),
    open: async (cwd, sessionId) => {
      expect(cwd).toBe(targetCwd);
      temporaryId = sessionId ?? "";
      opens.push({ cwd, sessionId: temporaryId });
      await access(file(targetCwd, temporaryId));
      context.handlers.update({
        sessionId: temporaryId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "fork", description: "Fork" }],
        },
      } as never);
      return { sessionId: temporaryId, configOptions };
    },
    prompt: async (sessionId, input) => {
      prompt(sessionId, input);
      forkOrdinal++;
      currentDerivedId = forkOrdinal === 1 ? "derived" : `derived-${forkOrdinal}`;
      const sourceRows = nativeHistoryRows(await readFile(file(targetCwd, sessionId), "utf8"));
      const prefix = forkOrdinal === 1 ? "new-" : `again-${forkOrdinal}-`;
      const ids = new Map(sourceRows.map((row) => [String(row.id), `${prefix}${row.id}`]));
      const clones = sourceRows.map((row) => {
        const clone: Record<string, unknown> = { ...row };
        delete clone.sessionId;
        return {
          ...clone,
          id: ids.get(String(row.id)),
          ...(row.parentId ? { parentId: ids.get(String(row.parentId)) } : {}),
          ...(row.logicalParentId ? { logicalParentId: ids.get(String(row.logicalParentId)) } : {}),
        };
      });
      await mkdir(path.dirname(file(targetCwd, currentDerivedId)), { recursive: true });
      await writeFile(
        file(targetCwd, currentDerivedId),
        jsonl([
          ...clones,
          {
            id: forkOrdinal === 1 ? "fork-command" : `fork-command-${forkOrdinal}`,
            parentId: clones.at(-1)?.id,
            type: "message",
            role: "user",
            content: "/fork",
            sessionId: currentDerivedId,
            cwd: targetCwd,
          },
        ]),
      );
      if (options.nativeCopiesChild && options.withChild && forkOrdinal === 1) {
        await mkdir(path.dirname(childFile(targetCwd, currentDerivedId)), { recursive: true });
        await writeFile(childFile(targetCwd, currentDerivedId), childPrefixContents, {
          mode: 0o600,
        });
      }
      if (options.sourceRace)
        await writeFile(
          file(sourceCwd, "source"),
          contents + jsonl([{ type: "session-meta", sessionId: "source" }]),
        );
      context.handlers.update({
        sessionId: currentDerivedId,
        update: {
          sessionUpdate: "session_info_update",
          _meta: {
            "codebuddy.ai/sessionReset": true,
            "codebuddy.ai/newSessionId": currentDerivedId,
          },
        },
      } as never);
      return { stopReason: "end_turn" };
    },
    rollback: async (_sessionId, point) => {
      rollback(point);
      if (!options.badRewind)
        await writeFile(
          file(targetCwd, currentDerivedId),
          (await readFile(file(targetCwd, currentDerivedId), "utf8")) +
            jsonl([
              {
                type: "resend-fork-notice",
                id: "rewind",
                ...(point ? { parentId: point } : {}),
                sessionId: currentDerivedId,
                cwd: targetCwd,
              },
            ]),
        );
      return { applied: true, actualForkPointId: point };
    },
    configure: async (_sessionId, id, value) => ({
      configOptions: configOptions.map((option) => ({
        ...option,
        currentValue: option.id === id ? value : option.currentValue,
      })),
    }),
    cancel: async () => {},
    answer: async () => {},
    close: async () => {},
  });
  const run = (override: Partial<Parameters<typeof deriveCodeBuddySession>[0]> = {}) =>
    deriveCodeBuddySession({
      input: { kind: "fork", cwd: targetCwd, sourceRef, checkpoint },
      sourceCwd,
      environment,
      factory,
      profile: WORKBUDDY_RUNTIME_PROFILE,
      signal: new AbortController().signal,
      copy,
      ...override,
    });
  return {
    sourceCwd,
    targetCwd,
    environment,
    contents,
    childContents,
    childPrefixContents,
    file,
    childFile,
    copy,
    prompt,
    rollback,
    opens,
    factory,
    run,
  };
}

describe("WorkBuddy native history derivation", () => {
  it("forks across cwd through a byte-exact target bridge and binds the final Session", async () => {
    const fixture = await setup();
    await expect(
      codeBuddyNativeHistory(
        fixture.targetCwd,
        sourceRef,
        fixture.environment,
        WORKBUDDY_RUNTIME_PROFILE,
      ),
    ).rejects.toThrow("not stored in the requested working directory");
    const derived = await fixture.run();
    expect(fixture.prompt).toHaveBeenCalledWith(expect.any(String), "/fork");
    expect(fixture.rollback).toHaveBeenCalledWith("new-result");
    expect(await readFile(fixture.file(fixture.sourceCwd, "source"), "utf8")).toBe(
      fixture.contents,
    );
    await expect(access(fixture.file(fixture.targetCwd, "derived"))).resolves.toBeUndefined();
    await expect(access(fixture.file(fixture.sourceCwd, "derived"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const temporaryId = fixture.copy.mock.calls[0]?.[2];
    expect(temporaryId).toBeTruthy();
    await expect(
      access(fixture.file(fixture.targetCwd, String(temporaryId))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(fixture.file(fixture.sourceCwd, String(temporaryId))),
    ).resolves.toBeUndefined();

    const history = await codeBuddyNativeHistory(
      fixture.targetCwd,
      derived.nativeRef,
      fixture.environment,
      WORKBUDDY_RUNTIME_PROFILE,
    );
    expect(history.historicalCwds.map(codeBuddyCanonicalCwd)).toEqual([
      codeBuddyCanonicalCwd(fixture.targetCwd),
    ]);
    expect(
      (
        await codeBuddyNativeHistory(
          fixture.targetCwd,
          derived.nativeRef,
          fixture.environment,
          WORKBUDDY_RUNTIME_PROFILE,
        )
      ).historicalCwds.map(codeBuddyCanonicalCwd),
    ).toEqual([codeBuddyCanonicalCwd(fixture.targetCwd)]);
    expect(nativeHistoryRows(history.contents).map((row) => row.id)).toEqual([
      "new-u1",
      "new-a1",
      "new-tool",
      "new-result",
    ]);
    expect(derived.nativeRef.locator).toMatchObject({
      codebuddyDerived: 1,
      boundCwd: codeBuddyCanonicalCwd(fixture.targetCwd),
      targetProjectSlug: expect.any(String),
      inheritedPrefixRows: 4,
      inheritedPrefixSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      bindingMarkerId: "fork-command",
    });
    const snapshot = snapshotFromHistory(
      history.contents,
      derived.nativeRef,
      fixture.targetCwd,
      WORKBUDDY_RUNTIME_PROFILE,
    );
    expect(snapshot.turns[0]?.checkpoint?.checkpointId).toBe("new-u1");
    expect(snapshot.turns[0]?.items[1]?.item).toMatchObject({
      type: "commandExecution",
      cwd: fixture.sourceCwd,
    });
  });

  it.each([
    ["cross-cwd", false],
    ["same-cwd", true],
  ])(
    "copies the exact retained child range for a %s Fork and reads it repeatedly",
    async (_label, sameCwd) => {
      const fixture = await setup({ sameCwd, withChild: true });
      const sourceChild = fixture.childFile(fixture.sourceCwd, "source");
      const before = await readFile(sourceChild);
      const derived = await fixture.run();
      const targetChild = fixture.childFile(fixture.targetCwd, derived.nativeRef.nativeSessionId);
      expect(await readFile(targetChild, "utf8")).toBe(fixture.childPrefixContents);
      expect(await readFile(sourceChild)).toEqual(before);
      if (process.platform !== "win32") expect((await stat(targetChild)).mode & 0o777).toBe(0o600);
      expect(derived.nativeRef.locator).toMatchObject({
        codebuddyInheritedChildren: [
          {
            childId: "agent-child",
            nativeSessionId: "native-child",
            inheritedBytes: Buffer.byteLength(fixture.childPrefixContents),
            inheritedRows: 2,
            inheritedSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            historicalCwds: [codeBuddyCanonicalCwd(fixture.sourceCwd)],
          },
        ],
      });
      // The derived transcript is independent after the operation leaves the source untouched.
      await rm(path.dirname(sourceChild), { recursive: true });

      const adapter = new WorkBuddyAdapter({
        environment: fixture.environment,
        clientFactory: fixture.factory,
      });
      try {
        const request = {
          parent: derived.nativeRef,
          nativeSubagentId: "agent-child",
          cwd: fixture.targetCwd,
        };
        const first = await adapter.subagents.readSnapshot(request);
        const second = await adapter.subagents.readSnapshot(request);
        expect(first).toMatchObject({ ok: true, value: { turns: expect.any(Array) } });
        expect(second).toEqual(first);
        if (!first.ok) throw new Error(first.error.message);
        expect(first.value.turns[0]?.nativeTurnRef.nativeSessionId).toBe(
          derived.nativeRef.nativeSessionId,
        );
        expect(first.value.turns[0]?.checkpoint).toBeUndefined();
      } finally {
        await adapter.close();
      }
    },
  );

  it("accepts an exact private child copy already created by native /fork", async () => {
    const fixture = await setup({ withChild: true, nativeCopiesChild: true });
    const derived = await fixture.run();
    const targetChild = fixture.childFile(fixture.targetCwd, derived.nativeRef.nativeSessionId);
    expect(await readFile(targetChild, "utf8")).toBe(fixture.childPrefixContents);
    if (process.platform !== "win32") expect((await stat(targetChild)).mode & 0o777).toBe(0o600);
  });

  it("accepts later target Turns but rejects forged provenance and a foreign suffix", async () => {
    const fixture = await setup();
    const derived = await fixture.run();
    const derivedFile = fixture.file(fixture.targetCwd, "derived");
    const before = await readFile(derivedFile, "utf8");
    const append = async (cwd: string) =>
      writeFile(
        derivedFile,
        before +
          jsonl([
            {
              id: "u3",
              parentId: "new-result",
              type: "message",
              role: "user",
              content: "target turn",
              sessionId: "derived",
              cwd,
            },
            {
              id: "a3",
              parentId: "u3",
              type: "message",
              role: "assistant",
              content: "target answer",
              status: "completed",
              sessionId: "derived",
              cwd,
            },
          ]),
      );
    await append(fixture.targetCwd);
    await expect(
      codeBuddyNativeHistory(
        fixture.targetCwd,
        derived.nativeRef,
        fixture.environment,
        WORKBUDDY_RUNTIME_PROFILE,
      ),
    ).resolves.toBeDefined();

    const locator = derived.nativeRef.locator as Record<string, unknown>;
    await expect(
      codeBuddyNativeHistory(
        fixture.targetCwd,
        { ...derived.nativeRef, locator: { ...locator, inheritedPrefixSha256: "0".repeat(64) } },
        fixture.environment,
        WORKBUDDY_RUNTIME_PROFILE,
      ),
    ).rejects.toThrow("prefix verification failed");
    await expect(
      codeBuddyNativeHistory(
        fixture.targetCwd,
        { ...derived.nativeRef, locator: { ...locator, bindingMarkerId: "forged" } },
        fixture.environment,
        WORKBUDDY_RUNTIME_PROFILE,
      ),
    ).rejects.toThrow("target marker is missing");
    await append(fixture.sourceCwd);
    await expect(
      codeBuddyNativeHistory(
        fixture.targetCwd,
        derived.nativeRef,
        fixture.environment,
        WORKBUDDY_RUNTIME_PROFILE,
      ),
    ).rejects.toThrow("left its target directory");
  });

  it("recursively forks a derived Ref while preserving its pinned inherited prefix", async () => {
    const fixture = await setup({ withChild: true });
    const first = await fixture.run();
    const originalCanonicalCwd = codeBuddyCanonicalCwd(fixture.sourceCwd);
    const firstFile = fixture.file(fixture.targetCwd, first.nativeRef.nativeSessionId);
    const firstBytes = await readFile(firstFile, "utf8");
    const firstChildFile = fixture.childFile(fixture.targetCwd, first.nativeRef.nativeSessionId);
    const firstChildBytes = await readFile(firstChildFile);
    const firstHistory = await codeBuddyNativeHistory(
      fixture.targetCwd,
      first.nativeRef,
      fixture.environment,
      WORKBUDDY_RUNTIME_PROFILE,
    );
    const recursiveCheckpoint = snapshotFromHistory(
      firstHistory.contents,
      first.nativeRef,
      fixture.targetCwd,
      WORKBUDDY_RUNTIME_PROFILE,
    ).turns[0]?.checkpoint;
    if (!recursiveCheckpoint) throw new Error("Missing recursive checkpoint");
    await rm(fixture.sourceCwd, { recursive: true });

    const second = await fixture.run({
      input: {
        kind: "fork",
        cwd: fixture.targetCwd,
        sourceRef: first.nativeRef,
        checkpoint: recursiveCheckpoint,
      },
      sourceCwd: fixture.targetCwd,
    });
    expect(second.nativeRef.nativeSessionId).toBe("derived-2");
    expect(await readFile(firstFile, "utf8")).toBe(firstBytes);
    expect(await readFile(firstChildFile)).toEqual(firstChildBytes);
    const secondHistory = await codeBuddyNativeHistory(
      fixture.targetCwd,
      second.nativeRef,
      fixture.environment,
      WORKBUDDY_RUNTIME_PROFILE,
    );
    expect(nativeHistoryRows(secondHistory.contents).map((row) => row.id)).toEqual([
      "again-2-new-u1",
      "again-2-new-a1",
      "again-2-new-tool",
      "again-2-new-result",
      "again-2-new-agent-tool",
      "again-2-new-agent-result",
    ]);
    expect(second.nativeRef.locator).toMatchObject({
      codebuddyDerived: 1,
      inheritedPrefixRows: 6,
      bindingMarkerId: "fork-command-2",
      codebuddyInheritedChildren: [
        {
          childId: "agent-child",
          inheritedRows: 2,
          historicalCwds: [originalCanonicalCwd],
        },
      ],
    });
    expect(
      await readFile(
        fixture.childFile(fixture.targetCwd, second.nativeRef.nativeSessionId),
        "utf8",
      ),
    ).toBe(fixture.childPrefixContents);
    const adapter = new WorkBuddyAdapter({
      environment: fixture.environment,
      clientFactory: fixture.factory,
    });
    try {
      await expect(
        adapter.subagents.readSnapshot({
          parent: second.nativeRef,
          nativeSubagentId: "agent-child",
          cwd: fixture.targetCwd,
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await adapter.close();
    }
  });

  it("revalidates a cross-cwd derived parent for repeated child reads without child checkpoints", async () => {
    const fixture = await setup();
    const derived = await fixture.run();
    const project = path.dirname(
      fixture.file(fixture.targetCwd, derived.nativeRef.nativeSessionId),
    );
    const children = path.join(project, derived.nativeRef.nativeSessionId, "subagents");
    await mkdir(children, { recursive: true });
    await writeFile(
      path.join(children, "agent-child.jsonl"),
      jsonl([
        {
          id: "child-user",
          type: "message",
          role: "user",
          content: "inspect",
          sessionId: "native-child",
          cwd: fixture.targetCwd,
        },
      ]),
    );
    const observer = new CodeBuddyChildObserver(
      derived.nativeRef,
      fixture.targetCwd,
      fixture.environment,
      WORKBUDDY_RUNTIME_PROFILE,
    );
    try {
      const first = await observer.read("agent-child", "running");
      const second = await observer.read("agent-child", "running");
      expect(first.turns[0]?.checkpoint).toBeUndefined();
      expect(second.turns[0]?.checkpoint).toBeUndefined();
      expect(second.turns[0]?.nativeTurnRef.nativeSessionId).toBe(
        derived.nativeRef.nativeSessionId,
      );
    } finally {
      observer.close();
    }
  });

  it("rolls back exactly the last logical Turn and carries explicit revision settings", async () => {
    const fixture = await setup({ sameCwd: true });
    const derived = await fixture.run({
      input: {
        kind: "rollbackLastTurn",
        cwd: fixture.targetCwd,
        sourceRef,
        model: modelRef("other"),
        permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      },
    });
    expect(fixture.rollback).toHaveBeenCalledWith("new-result");
    expect(derived).toMatchObject({
      model: modelRef("other"),
      permissionModeId: "plan",
      thinkingOptionId: "high",
    });
  });

  it.each([false, true])(
    "accepts Windows mode bits and cleans the bridge (native child copy: %s)",
    async (nativeCopiesChild) => {
      const fixture = await setup({ withChild: true, nativeCopiesChild });
      simulatedWindows.enabled = true;
      vi.stubGlobal("process", { ...process, platform: "win32" });

      await fixture.run();

      const temporaryId = fixture.opens[0]?.sessionId;
      if (!temporaryId) throw new Error("missing temporary native copy identity");
      await expect(access(fixture.file(fixture.targetCwd, temporaryId))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("still rejects group/other-writable Subagent directories on POSIX", async () => {
    const fixture = await setup({ withChild: true });
    simulatedWindows.enabled = true;
    vi.stubGlobal("process", { ...process, platform: "darwin" });

    await expect(fixture.run()).rejects.toThrow("Redirected native Subagent directory");
  });

  it.each([
    ["source mutation", { sourceRace: true }, "Source history changed"],
    ["unpersisted rewind", { badRewind: true }, "did not persist"],
  ])("fails closed for %s", async (_label, options, message) => {
    const fixture = await setup(options);
    await expect(fixture.run()).rejects.toThrow(message);
  });

  it.runIf(process.platform !== "win32")(
    "preserves the native failure when bridge cleanup also fails",
    async () => {
      const fixture = await setup({ sourceRace: true, cleanupFailure: true });
      const project = path.dirname(fixture.file(fixture.targetCwd, "derived"));
      try {
        const error = await fixture.run().catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors[0]).toMatchObject({
          message: expect.stringContaining("Source history changed"),
        });
        expect((error as AggregateError).errors[1]).toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(project, 0o700);
      }
    },
  );
});
