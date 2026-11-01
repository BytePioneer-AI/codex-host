import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KimiAdapter, type KimiAcpTransportLike } from "../src/kimi-adapter.js";
import { KimiRollbackError } from "../src/native-rollback.js";
import {
  createKimiNativeSessionRef,
  extractKimiUsageFromWireLog,
  parseKimiWireLog,
} from "../src/history.js";
import { activeKimiWireRecords } from "../src/wire-history.js";
import { appendKimiCommandHistory } from "../src/command-history.js";
import { encodeKimiModelRef } from "../src/models.js";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";

const records = [
  { type: "turn.prompt", turnId: 0, input: [{ type: "text", text: "first" }], time: 1 },
  { type: "turn.ended", turnId: 0, reason: "completed", time: 2 },
  { type: "turn.prompt", turnId: 1, input: [{ type: "text", text: "second" }], time: 3 },
  { type: "turn.ended", turnId: 1, reason: "completed", time: 4 },
];
const wire = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

describe("Kimi native rollback", () => {
  let root: string;
  let nativeHome: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "kimi-rollback-"));
    nativeHome = path.join(root, "native");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function save(id: string, rows: unknown[]) {
    const sessionDir = path.join(nativeHome, "sessions", id);
    await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
    await appendFile(
      path.join(nativeHome, "session_index.jsonl"),
      wire([{ sessionId: id, sessionDir }]),
    );
    await writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify({ id, version: 2, cwd: root }),
    );
    await writeFile(path.join(sessionDir, "agents", "main", "wire.jsonl"), wire(rows));
    return sessionDir;
  }
  function setup(
    rollbackNativeSession: NonNullable<
      NonNullable<ConstructorParameters<typeof KimiAdapter>[1]>["rollbackNativeSession"]
    >,
  ) {
    const config: Record<string, string> = { model: "relay", thinking: "medium", mode: "default" };
    const transport = {
      sessionId: "derived",
      isClosed: false,
      setActivePromptHandler: vi.fn(),
      setSessionEventHandler: vi.fn(),
      inspect: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      openSession: vi.fn(async () => ({ sessionId: "derived", configOptions: [] })),
      setConfigOption: vi.fn(async (id: string, value: string) => {
        config[id] = value;
        return Object.entries(config).map(([id, currentValue]) => ({
          id,
          currentValue,
          ...(id === "thinking"
            ? { options: ["off", "medium", "high"].map((value) => ({ value, name: value })) }
            : {}),
        }));
      }),
    } satisfies KimiAcpTransportLike;
    const adapter = new KimiAdapter(
      { environment: { KIMI_CODE_HOME: nativeHome } },
      {
        resolveExecutable: () => "kimi",
        createTransport: () => transport,
        rollbackNativeSession,
      },
    );
    return { adapter, transport };
  }
  const config = {
    sessionId: "derived",
    model: "relay",
    thinking: "medium",
    mode: "default" as const,
  };

  it.each([1, 2])(
    "removes exactly the last of %i turns and preserves source and configuration",
    async (count) => {
      const source = await save("source", records.slice(0, count * 2));
      const original = await readFile(path.join(source, "agents", "main", "wire.jsonl"), "utf8");
      const native = vi.fn(async () => {
        await save("derived", records.slice(0, (count - 1) * 2));
        return config;
      });
      const { adapter, transport } = setup(native);
      const result = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: createKimiNativeSessionRef("source", root),
        cwd: root,
        model: encodeKimiModelRef("selected"),
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(await result.value.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: expect.any(Array) },
      });
      const snapshot = await result.value.readSnapshot();
      if (snapshot.ok) expect(snapshot.value.turns).toHaveLength(count - 1);
      expect(result.value.initialState).toMatchObject({
        effectiveModel: encodeKimiModelRef("selected"),
        effectiveThinkingOptionId: "high",
        effectivePermissionModeId: "auto",
      });
      expect(transport.openSession).toHaveBeenCalledWith({
        kind: "load",
        sessionId: "derived",
        cwd: root,
      });
      expect(native).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceSessionId: "source",
          environment: expect.objectContaining({ KIMI_CODE_HOME: nativeHome }),
        }),
      );
      expect(await readFile(path.join(source, "agents", "main", "wire.jsonl"), "utf8")).toBe(
        original,
      );
      await adapter.close();
    },
  );

  it("does not create a copy for an empty session or unfinished turn", async () => {
    const native = vi.fn();
    const { adapter } = setup(native);
    await save("source", []);
    expect(
      await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: createKimiNativeSessionRef("source", root),
        cwd: root,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
    await save("source", records.slice(0, 1));
    expect(
      await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: createKimiNativeSessionRef("source", root),
        cwd: root,
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(native).not.toHaveBeenCalled();
  });

  it("preserves earlier command replies under the derived identity and rejects revising commands", async () => {
    await save("source", records);
    await appendKimiCommandHistory(
      {
        nativeTurnRef: {
          ...createKimiNativeSessionRef("source", root),
          nativeTurnKey: "turn:command:status",
        },
        input: [{ type: "text", text: "/status" }],
        items: [],
        outcome: { status: "succeeded" },
        startedAtMs: 2.5,
      },
      { kimiCodeHome: nativeHome },
    );
    const native = vi.fn(async () => {
      await save("derived", records.slice(0, 2));
      return config;
    });
    const { adapter } = setup(native);
    const result = await adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: createKimiNativeSessionRef("source", root),
      cwd: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const snapshot = await result.value.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          { nativeTurnRef: { nativeSessionId: "derived", nativeTurnKey: "turn:0" } },
          { nativeTurnRef: { nativeSessionId: "derived", nativeTurnKey: "turn:command:status" } },
        ],
      },
    });
    expect(
      await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: createKimiNativeSessionRef("derived", root),
        cwd: root,
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(native).toHaveBeenCalledTimes(1);
    await adapter.close();
  });

  it("keeps source intact when native undo is unavailable and rejects a wrong prefix", async () => {
    const source = await save("source", records);
    const original = await readFile(path.join(source, "agents", "main", "wire.jsonl"), "utf8");
    const native = vi.fn(async () => {
      throw new KimiRollbackError("unsupported", "compaction boundary");
    });
    const { adapter, transport } = setup(native);
    expect(
      await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: createKimiNativeSessionRef("source", root),
        cwd: root,
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const wrong = setup(async () => {
      await save("derived", records.slice(2));
      return config;
    });
    expect(
      await wrong.adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: createKimiNativeSessionRef("source", root),
        cwd: root,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", message: expect.stringContaining("preceding conversation") },
    });
    expect(transport.openSession).not.toHaveBeenCalled();
    expect(wrong.transport.openSession).not.toHaveBeenCalled();
    expect(await readFile(path.join(source, "agents", "main", "wire.jsonl"), "utf8")).toBe(
      original,
    );
  });
});

it("reads the active native branch after repeated undo and continuation, including usage", async () => {
  const log = wire([
    ...records,
    { type: "agent.switched", branch: "b1", base: { branch: "main", line: 3 } },
    { type: "context.undo", count: 1 },
    { type: "context.undone", fromTurnId: 1, turns: 1 },
    { type: "token_counting.truncated", tokens: 15 },
    { ...records[2], input: [{ type: "text", text: "revised" }] },
    records[3],
    { type: "agent.switched", branch: "b2", base: { branch: "main", line: 2 } },
    { type: "context.undo", count: 1 },
    { type: "token_counting.truncated", tokens: 10 },
  ]);
  expect((await parseKimiWireLog(log, "source")).map((turn) => turn.input)).toEqual([
    [{ type: "text", text: "first" }],
  ]);
  expect(extractKimiUsageFromWireLog(log)?.contextUsedTokens).toBe(10);
  expect(() =>
    activeKimiWireRecords(
      wire([{ type: "agent.switched", branch: "b1", base: { branch: "missing", line: 0 } }]),
    ),
  ).toThrow("Invalid Kimi branch base");
});
