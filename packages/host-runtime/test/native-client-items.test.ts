import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { NativeClientItems } from "../src/native-client-items.js";
import { NativeClientChannel, type NativeClientReply } from "../src/native-client-channel.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";

const user = (id: string, startedAtMs: number): JsonObject => ({
  id,
  type: "userMessage",
  clientId: id,
  content: [{ type: "text", text: id }],
  startedAtMs,
});
const tool = (status = "inProgress"): JsonObject => ({
  id: "tool",
  type: "commandExecution",
  command: "sleep 1",
  status,
  aggregatedOutput: null,
  startedAtMs: 20,
});
const compaction = (): JsonObject => ({ id: "compact", type: "contextCompaction" });
const page = (items: JsonObject[]): JsonObject => ({
  data: [{ id: "turn", status: "inProgress", itemsView: "full", items }],
  nextCursor: null,
});
function projected(items: NativeClientItems, row: JsonObject) {
  return items.project("thread", row).data as Array<{ items: JsonObject[] }>;
}

it("projects a native command start and output while both native history APIs still omit it", () => {
  const items = new NativeClientItems();
  items.observe("item/started", { threadId: "thread", turnId: "turn", item: tool() });
  items.observe("item/commandExecution/outputDelta", {
    threadId: "thread",
    turnId: "turn",
    itemId: "tool",
    delta: "live",
  });
  const raw = page([user("opening", 10), user("steer", 30)]);
  expect(projected(items, raw)[0]?.items).toEqual([
    user("opening", 10),
    { ...tool(), aggregatedOutput: "live" },
    user("steer", 30),
  ]);
  expect((raw.data as Array<{ items: JsonObject[] }>)[0]?.items).toHaveLength(2);
  const copy = projected(items, raw)[0]?.items[1];
  if (copy) copy.aggregatedOutput = "mutated by caller";
  expect(projected(items, raw)[0]?.items[1]?.aggregatedOutput).toBe("live");
});

it("keeps completion through a lagging read, then uses authoritative native history and chronology", () => {
  const items = new NativeClientItems();
  items.observe("item/started", { threadId: "thread", turnId: "turn", item: tool() });
  items.observe("item/completed", {
    threadId: "thread",
    turnId: "turn",
    item: { ...tool("completed"), aggregatedOutput: "done", exitCode: 0 },
  });
  items.observe("item/started", { threadId: "thread", turnId: "turn", item: tool() });
  const lagging = page([user("opening", 10), user("steer", 30)]);
  expect(projected(items, lagging)[0]?.items[1]).toMatchObject({
    status: "completed",
    aggregatedOutput: "done",
  });
  const persisted = page([
    user("opening", 10),
    user("steer", 30),
    { ...tool("completed"), aggregatedOutput: "full native output" },
  ]);
  expect(projected(items, persisted)[0]?.items.map((item) => item.id)).toEqual([
    "opening",
    "tool",
    "steer",
  ]);
  expect(projected(items, persisted)[0]?.items[1]?.aggregatedOutput).toBe("full native output");
  // No second transcript: once native history has the final Item, it can remove it.
  expect(projected(items, lagging)[0]?.items.map((item) => item.id)).toEqual(["opening", "steer"]);
});

it("uses native timestamps on cold history, without guessing missing timestamps or breaking ties", () => {
  const items = new NativeClientItems();
  expect(
    projected(
      items,
      page([user("opening", 10), user("steer", 30), tool("completed")]),
    )[0]?.items.map((item) => item.id),
  ).toEqual(["opening", "tool", "steer"]);
  const unknown = { ...user("unknown", 10), startedAtMs: null };
  expect(
    projected(items, page([unknown, user("steer", 30), tool("completed")]))[0]?.items.map(
      (item) => item.id,
    ),
  ).toEqual(["unknown", "steer", "tool"]);
  expect(
    projected(items, page([user("a", 20), tool("completed"), user("b", 20)]))[0]?.items.map(
      (item) => item.id,
    ),
  ).toEqual(["a", "tool", "b"]);
});

it.each([tool(), compaction()])(
  "does not invent Turns, modify other Threads or supply $type Items to notLoaded pages",
  (item) => {
    const items = new NativeClientItems();
    items.observe("item/started", { threadId: "thread", turnId: "turn", item });
    expect(items.project("other", page([]))).toEqual(page([]));
    expect(items.project("thread", { data: [], nextCursor: null })).toEqual({
      data: [],
      nextCursor: null,
    });
    const unloaded = {
      data: [{ id: "turn", items: [], itemsView: "notLoaded" }],
      nextCursor: null,
    };
    expect(items.project("thread", unloaded)).toEqual(unloaded);
  },
);

it.each(["closed", "reset"])("retires volatile Items on %s", (reason) => {
  const items = new NativeClientItems();
  items.observe("item/started", { threadId: "thread", turnId: "turn", item: tool() });
  items.observe("item/started", { threadId: "thread", turnId: "turn", item: compaction() });
  if (reason === "closed") items.observe("thread/closed", { threadId: "thread" });
  else items.clear();
  expect(items.project("thread", page([]))).toEqual(page([]));
});

it("marks persisted native compactions completed without mutating native history", () => {
  const items = new NativeClientItems();
  const raw = page([compaction()]);
  expect(projected(items, raw)[0]?.items).toEqual([{ ...compaction(), status: "completed" }]);
  expect((raw.data as Array<{ items: JsonObject[] }>)[0]?.items).toEqual([compaction()]);
});

it.each(["failed", "interrupted", "completed"])(
  "settles an unfinished compaction without claiming success when its Turn is %s",
  (status) => {
    const items = new NativeClientItems();
    items.observe("item/started", { threadId: "thread", turnId: "turn", item: compaction() });
    const raw = {
      data: [{ id: "turn", status, itemsView: "full", items: [] }],
      nextCursor: null,
    };
    const result = projected(items, raw)[0]?.items[0];
    expect(result).toMatchObject({
      ...compaction(),
      status: status === "failed" ? "failed" : "interrupted",
    });
    expect(result?.error).toHaveProperty("message");
  },
);

it("projects native compaction notifications into snapshots and never reopens a completed Item", async () => {
  const events = new ClientChannelEvents();
  let history = page([user("opening", 10)]);
  const request = vi.fn(async (method: string): Promise<NativeClientReply> => {
    if (method === "thread/resume") return { result: {} };
    if (method === "thread/read")
      return {
        result: {
          thread: {
            id: "thread",
            cwd: "/tmp",
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "active" },
          },
        },
      };
    if (method === "thread/turns/list") return { result: history };
    throw new Error(method);
  });
  const channel = new NativeClientChannel({ events, request, respond: async () => {} });
  const started = {
    method: "item/started",
    params: { threadId: "thread", turnId: "turn", item: compaction(), startedAtMs: 20 },
  };
  const original = structuredClone(started);
  channel.observeMessage(started);
  expect((await channel.snapshot("thread", {})).turnsPage.data[0]?.items).toEqual([
    user("opening", 10),
    { ...compaction(), status: "inProgress", startedAtMs: 20 },
  ]);
  expect(started).toEqual(original);

  channel.observeMessage({
    method: "item/completed",
    params: { threadId: "thread", turnId: "turn", item: compaction(), completedAtMs: 30 },
  });
  channel.observeMessage(started);
  const snapshot = await channel.snapshot("thread", {});
  expect(snapshot.turnsPage.data[0]).toMatchObject({
    status: "inProgress",
    items: [user("opening", 10), { ...compaction(), status: "completed" }],
  });

  history = page([user("opening", 10), compaction()]);
  expect((await channel.snapshot("thread", {})).turnsPage.data[0]?.items).toHaveLength(2);
  // Duplicate starts and a lagging page must not re-open a completion already observed.
  channel.observeMessage(started);
  history = page([user("opening", 10)]);
  expect((await channel.snapshot("thread", {})).turnsPage.data[0]?.items[1]?.status).toBe(
    "completed",
  );

  const next = { id: "compact-2", type: "contextCompaction" };
  channel.observeMessage({
    method: "item/started",
    params: { threadId: "thread", turnId: "turn", item: next },
  });
  expect((await channel.snapshot("thread", {})).turnsPage.data[0]?.items.at(-1)).toMatchObject({
    ...next,
    status: "inProgress",
  });
  channel.resetGeneration();
  expect((await channel.snapshot("thread", {})).turnsPage.data[0]?.items).toEqual([
    user("opening", 10),
  ]);
});

it("publishes the live command into the real Client Channel snapshot before invalidating readers", async () => {
  const events = new ClientChannelEvents();
  const request = vi.fn(async (method: string): Promise<NativeClientReply> => {
    if (method === "thread/resume") return { result: {} };
    if (method === "thread/read")
      return {
        result: {
          thread: {
            id: "thread",
            cwd: "/tmp",
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "active" },
          },
        },
      };
    if (method === "thread/turns/list")
      return { result: page([user("opening", 10), user("steer", 30)]) };
    throw new Error(method);
  });
  const channel = new NativeClientChannel({ events, request, respond: async () => {} });
  channel.observeMessage({
    method: "item/started",
    params: { threadId: "thread", turnId: "turn", item: tool() },
  });
  const first = await channel.snapshot("thread", {});
  expect(first.turnsPage.data[0]?.items.map((item) => item.id)).toEqual([
    "opening",
    "tool",
    "steer",
  ]);
  channel.observeMessage({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread", turnId: "turn", itemId: "tool", delta: "output" },
  });
  expect((await channel.snapshot("thread", {})).turnsPage.data[0]?.items[1]?.aggregatedOutput).toBe(
    "output",
  );
  channel.resetGeneration();
  expect(
    (await channel.snapshot("thread", {})).turnsPage.data[0]?.items.map((item) => item.id),
  ).toEqual(["opening", "steer"]);
});
