import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import {
  GOTGENES_EXTENSION,
  GOTGENES_PREFIX,
  GOTGENES_WIDGET,
  ensureGotgenesExtension,
} from "../src/pi-gotgenes-extension.js";
import {
  gotgenesId,
  gotgenesRecord,
  gotgenesToolRecord,
  parseGotgenesId,
  parseGotgenesWidget,
} from "../src/pi-gotgenes-subagents.js";
import { gotgenesHistory, readGotgenesChild, restoreGotgenes } from "../src/pi-gotgenes-history.js";
import { PiSubagents } from "../src/pi-subagents.js";
import { mapPiSnapshot, type PiSessionHistory } from "../src/pi-history.js";

const requiredRecord = (value: unknown) => {
  const record = gotgenesRecord(value);
  if (!record) throw new Error("Invalid native fixture");
  return record;
};

const native = (status = "running") => ({
  id: "7ccad94f-8df4-423",
  type: "Explore",
  description: "Inspect local changes",
  status,
  isBackground: true,
  toolUses: 2,
});
const receipt = (status = "background") => ({
  details: {
    agentId: native().id,
    displayName: "Explore",
    subagentType: "Explore",
    description: native().description,
    status,
    modelName: "openai-codex/gpt-6-astra",
    tags: ["background"],
    toolUses: 0,
  },
});
const turnId = hostTurnIdSchema.parse("parent-turn");
const itemId = hostItemIdSchema.parse("child-card");
const widget = (agents: unknown[], version = 1) => ({
  type: "extension_ui_request",
  method: "setWidget",
  widgetKey: GOTGENES_WIDGET,
  widgetLines: [GOTGENES_PREFIX + JSON.stringify({ version, agents })],
});
const history = (terminal: Record<string, unknown>): PiSessionHistory => ({
  leafId: "record",
  entries: [
    {
      id: "user",
      parentId: null,
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "inspect" }], timestamp: 1 },
    },
    {
      id: "call",
      parentId: "user",
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "subagent",
            arguments: { description: native().description },
          },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
    {
      id: "result",
      parentId: "call",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagent",
        toolCallId: "call-1",
        isError: false,
        ...receipt(),
      },
    },
    {
      id: "record",
      parentId: "result",
      type: "custom",
      customType: "subagents:record",
      data: JSON.parse(JSON.stringify(terminal)),
    },
  ],
});
const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("gotgenes native subagent observation", () => {
  it("recognizes exact structured receipts and stable opaque identities, rejecting malformed frames", () => {
    expect(parseGotgenesId(gotgenesId(native().id))).toBe(native().id);
    expect(parseGotgenesId("pi-subagents-v1:abc")).toBeNull();
    expect(() => parseGotgenesId(gotgenesId("../file"))).toThrow();
    expect(gotgenesToolRecord("subagent", receipt())?.child).toMatchObject({
      description: native().description,
      role: "Explore",
      model: "openai-codex/gpt-6-astra",
    });
    expect(gotgenesToolRecord("other", receipt())).toBeNull();
    expect(parseGotgenesWidget(widget([native()]))).toHaveLength(1);
    expect(parseGotgenesWidget(widget([native()], 2))).toBeNull();
    expect(parseGotgenesWidget(widget([{ ...native(), status: "unknown" }]))).toBeNull();
    expect(parseGotgenesWidget(widget(Array(129).fill(native())))).toBeNull();
  });

  it("starts a foreground card from native service before the blocking tool returns, without duplicating its receipt", () => {
    const events: HostEvent[] = [];
    const observer = new PiSubagents((event) => events.push(event));
    observer.observeGotgenes([requiredRecord({ ...native(), isBackground: false })], {
      turnId,
      nextItemId: () => itemId,
    });
    observer.start(
      turnId,
      "subagent",
      receipt("completed"),
      hostItemIdSchema.parse("unused"),
      "call",
    );
    expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);
    observer.observeGotgenes([requiredRecord({ ...native("completed"), result: "Finished" })]);
    observer.finish(turnId);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        snapshot: {
          item: expect.objectContaining({
            itemId,
            subagents: [
              expect.objectContaining({
                status: "completed",
                model: "openai-codex/gpt-6-astra",
                resultSummary: "Finished",
              }),
            ],
          }),
          outcome: { status: "succeeded" },
        },
      }),
    );
  });

  it.each([
    ["error", "failed"],
    ["stopped", "interrupted"],
    ["aborted", "interrupted"],
    ["completed", "completed"],
  ])(
    "preserves %s after parent completion and does not append items to finished turns",
    (status, expected) => {
      const events: HostEvent[] = [];
      const observer = new PiSubagents((event) => events.push(event));
      observer.start(turnId, "subagent", receipt(), itemId);
      observer.observeGotgenes([requiredRecord(native())]);
      observer.finish(turnId);
      events.length = 0;
      observer.observeGotgenes([requiredRecord(native(status))]);
      expect(events).toContainEqual({
        type: "subagent.state.changed",
        nativeSubagentId: gotgenesId(native().id),
        status: expected,
      });
      expect(events.some((event) => event.type.startsWith("item."))).toBe(false);
      events.length = 0;
      observer.observeGotgenes([]);
      expect(events).toEqual([]);
    },
  );

  it("restores final status and model from parent native records and keeps different children distinct", () => {
    const h = history({
      ...native("completed"),
      outputFile: "/parent/tasks/child.jsonl",
      result: "done",
    });
    const observer = new PiSubagents(() => undefined);
    restoreGotgenes(h, observer.gotgenes);
    const snapshot = mapPiSnapshot(h, { sessionId: "parent", model: null }, observer);
    const cards = snapshot.turns
      .flatMap((turn) => turn.items)
      .filter(({ item }) => item.type === "subagentDelegation");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.item).toMatchObject({
      subagents: [
        {
          nativeSubagentId: gotgenesId(native().id),
          status: "completed",
          model: "openai-codex/gpt-6-astra",
        },
      ],
    });
    expect(gotgenesId("different-agent")).not.toBe(gotgenesId(native().id));
    h.entries.push({
      id: "resumed",
      parentId: "record",
      type: "message",
      message: { role: "toolResult", toolName: "subagent", ...receipt() },
    });
    h.leafId = "resumed";
    expect(gotgenesHistory(h)[0]?.child.status).not.toBe("completed");
  });

  it("does not let parent history reads roll back observed running or resumed workers", () => {
    const observer = new PiSubagents(() => undefined);
    observer.observeGotgenes([requiredRecord({ ...native(), toolUses: 3 })]);
    const launchedOnly = history({ ...native("completed"), result: "old run" });
    launchedOnly.leafId = "result";
    restoreGotgenes(launchedOnly, observer.gotgenes);
    expect(observer.gotgenes.records.get(native().id)?.child).toMatchObject({
      status: "running",
      resultSummary: "3 tool uses",
    });
    // After a resume, the last persisted record still describes the preceding terminal run.
    restoreGotgenes(history({ ...native("completed"), result: "old run" }), observer.gotgenes);
    expect(observer.gotgenes.records.get(native().id)?.child.status).toBe("running");
    // Without a live source, later parent history is allowed to advance restored state.
    const cold = new PiSubagents(() => undefined);
    restoreGotgenes(launchedOnly, cold.gotgenes);
    restoreGotgenes(history({ ...native("completed"), result: "done" }), cold.gotgenes);
    expect(cold.gotgenes.records.get(native().id)?.child.status).toBe("completed");
  });

  it("does not overwrite a native role/background or resumed status with a query receipt", () => {
    const observer = new PiSubagents(() => undefined);
    observer.observeGotgenes([
      requiredRecord({ ...native(), type: "general-purpose", toolUses: 5 }),
    ]);
    observer.start(
      turnId,
      "get_subagent_result",
      {
        details: {
          ...receipt("completed").details,
          subagentType: undefined,
          tags: undefined,
          displayName: "Agent",
        },
      },
      itemId,
    );
    expect(observer.gotgenes.records.get(native().id)?.child).toMatchObject({
      role: "general-purpose",
      background: true,
      status: "running",
      resultSummary: "5 tool uses",
    });
    const h = history({ ...native("completed"), type: "general-purpose" });
    h.entries.push({
      id: "query",
      parentId: "record",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "get_subagent_result",
        details: {
          agentId: native().id,
          description: native().description,
          displayName: "Agent",
          status: "completed",
        },
      },
    });
    h.leafId = "query";
    expect(gotgenesHistory(h)[0]?.child).toMatchObject({
      role: "general-purpose",
      background: true,
    });
  });

  it("reads the actual child transcript, strips writable checkpoints, and rejects another parent's file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gotgenes-history-"));
    homes.push(directory);
    const file = path.join(directory, "child.jsonl");
    const entries = [
      { type: "session", version: 3, id: "child", parentSession: "parent", cwd: directory },
      {
        id: "u",
        parentId: null,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "child task" }], timestamp: 1 },
      },
      {
        id: "a",
        parentId: "u",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "real child answer" }],
          stopReason: "stop",
          timestamp: 2,
        },
      },
    ];
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const h = history({ ...native("completed"), outputFile: file });
    const result = await readGotgenesChild(h, "parent", native().id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(JSON.stringify(result.value)).toContain("real child answer");
    expect(result.value.turns.every((turn) => turn.checkpoint === undefined)).toBe(true);
    expect(await readGotgenesChild(h, "foreign", native().id)).toMatchObject({
      ok: false,
      error: { message: "Pi child Session parent identity mismatch" },
    });
    expect(await readGotgenesChild(h, "parent", "unknown")).toMatchObject({ ok: false });
  });

  it("bridges the public service after late registration and releases its timer on shutdown", async () => {
    vi.useFakeTimers();
    const hooks = new Map<string, (...args: unknown[]) => void>();
    const channels = new Map<string, () => void>();
    const frames: unknown[] = [];
    const serviceKey = Symbol.for("@gotgenes/pi-subagents:service");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const previous = globals[serviceKey];
    const pi = {
      on: (name: string, fn: (...args: unknown[]) => void) => hooks.set(name, fn),
      events: { on: (name: string, fn: () => void) => channels.set(name, fn) },
    };
    new Function(GOTGENES_EXTENSION.replace("export default function", "return function"))()(pi);
    try {
      hooks.get("session_start")?.(
        {},
        {
          ui: {
            setWidget: (key: string, lines: string[]) =>
              frames.push({ widgetKey: key, widgetLines: lines }),
          },
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(frames).toEqual([]);
      const records = [native()];
      globals[serviceKey] = { listAgents: () => records };
      channels.get("subagents:created")?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(frames).toHaveLength(1);
      // A child SDK loads the same plugin and shadows the process-global registration.
      globals[serviceKey] = { listAgents: () => [] };
      records[0] = { ...native("completed"), toolUses: 4 };
      await vi.advanceTimersByTimeAsync(1000);
      expect(frames).toHaveLength(2);
      // Session switching updates the context, not the owning plugin service instance.
      hooks.get("session_start")?.(
        {},
        {
          ui: {
            setWidget: (key: string, lines: string[]) =>
              frames.push({ widgetKey: key, widgetLines: lines }),
          },
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(frames).toHaveLength(3);
      expect(JSON.stringify(frames.at(-1))).toContain("completed");
      hooks.get("session_shutdown")?.();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(frames).toHaveLength(3);
    } finally {
      globals[serviceKey] = previous;
      hooks.get("session_shutdown")?.();
    }
  });

  it("writes an isolated content-addressed observer without changing Pi global configuration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gotgenes-extension-"));
    homes.push(directory);
    const [first, second] = await Promise.all([
      ensureGotgenesExtension({ CODEXHOST_DATA_DIR: directory }),
      ensureGotgenesExtension({ CODEXHOST_DATA_DIR: directory }),
    ]);
    expect(first).toBe(second);
    expect(first).toContain(path.join(directory, "extensions", "pi-subagent-observer"));
  });
});
