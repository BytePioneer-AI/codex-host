import { describe, expect, it, vi } from "vitest";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodexTurnProjector, type JsonObject } from "@codexhost/protocol-core";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";

import {
  completePiTurn,
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

function itemStarted(message: JsonObject, itemId: string): boolean {
  if (message.method !== "item/started") return false;
  return (message.params as { item?: { id?: string } }).item?.id === itemId;
}

function itemCompleted(message: JsonObject, itemId: string): boolean {
  if (message.method !== "item/completed") return false;
  return (message.params as { item?: { id?: string } }).item?.id === itemId;
}

function itemDelta(message: JsonObject, itemId: string): boolean {
  if (message.method !== "item/agentMessage/delta") return false;
  return (message.params as { itemId?: string }).itemId === itemId;
}

async function readHistoryItems(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
  id: number,
): Promise<JsonObject[]> {
  writeRequest(fixture.desktopInput, {
    id,
    method: "thread/read",
    params: { threadId, includeTurns: true },
  });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  const thread = ((response.result ?? {}) as JsonObject).thread as JsonObject;
  if (!thread) throw new Error(JSON.stringify(response));
  return ((thread.turns ?? []) as JsonObject[]).flatMap(
    (turn) => (turn.items ?? []) as JsonObject[],
  );
}

describe("Host runtime idle background output on a completed Turn", () => {
  it("streams a background Item on a completed Turn and overlays it onto served history", async () => {
    const fixture = await createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await completePiTurn(fixture, threadId, 2);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");

      const itemId = hostItemIdSchema.parse("bg-item-1");
      const id = hostTurnIdSchema.parse(turnId);
      session.emitEvent({
        type: "item.background.started",
        turnId: id,
        item: { type: "agentMessage", itemId, text: "" },
      });
      session.emitEvent({
        type: "item.updated",
        turnId: id,
        itemId,
        update: { type: "text.append", text: "awake\n" },
      });
      const started = await fixture.collector.waitFor((message) => itemStarted(message, itemId));
      expect(started.params).toMatchObject({
        turnId,
        item: { id: itemId, type: "agentMessage" },
      });
      const delta = await fixture.collector.waitFor((message) => itemDelta(message, itemId));
      expect(delta.params).toMatchObject({ delta: "awake\n" });

      // The unsettled background Item appears in served history via the
      // open-detached overlay, in progress with its accumulated text.
      const open = await readHistoryItems(fixture, threadId, 5);
      expect(open).toContainEqual(
        expect.objectContaining({ id: itemId, type: "agentMessage", text: "awake\n" }),
      );

      session.emitEvent({
        type: "item.completed",
        turnId: id,
        snapshot: {
          item: { type: "agentMessage", itemId, text: "awake\n" },
          outcome: { status: "succeeded" },
        },
      });
      const completed = await fixture.collector.waitFor((message) =>
        itemCompleted(message, itemId),
      );
      expect(completed.params).toMatchObject({
        turnId,
        item: { id: itemId, type: "agentMessage", text: "awake\n" },
      });

      // A successor Turn still starts and completes normally afterwards.
      const nextTurnId = await startPiTurn(fixture, threadId, 6);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", nextTurnId));
      session.appendText("answer 6");
      session.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", nextTurnId),
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("continues streaming alternating background Items after each settles", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      for (const [index, type] of (["reasoning", "agentMessage", "reasoning"] as const).entries()) {
        const itemId = hostItemIdSchema.parse(`alternating-${index}`);
        const item = { type, itemId, text: `text ${index}` };
        session.emitEvent({ type: "item.background.started", turnId, item });
        await fixture.collector.waitFor((message) => itemStarted(message, itemId));
        session.emitEvent({
          type: "item.completed",
          turnId,
          snapshot: { item, outcome: { status: "succeeded" } },
        });
        const wireId = type === "reasoning" ? `${itemId}-summary` : itemId;
        await fixture.collector.waitFor((message) => itemCompleted(message, wireId));
      }
      expect(fixture.diagnosticOutput.read()?.toString() ?? "").not.toContain("unknown Host Turn");
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([false, true])(
    "releases a settled detached command with successor=%s",
    async (successor) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId, 2));
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Pi Session was not opened");
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
        const itemId = session.startCommandExecution("sleep 100");
        session.detachItem(itemId);
        session.succeedTurn();
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        if (successor) await completePiTurn(fixture, threadId, 3);
        session.emitEvent({
          type: "item.completed",
          turnId,
          snapshot: {
            item: { type: "commandExecution", itemId, command: "sleep 100", cwd: "/synthetic" },
            outcome: { status: "succeeded" },
          },
        });
        await fixture.collector.waitFor((message) => itemCompleted(message, itemId));
        session.emitEvent({
          type: "item.background.started",
          turnId,
          item: { type: "agentMessage", itemId: hostItemIdSchema.parse("old-late"), text: "late" },
        });
        await vi.waitFor(() => {
          expect(fixture.diagnosticOutput.read()?.toString() ?? "").toContain("unknown Host Turn");
        });
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it.each([
    ["agentMessage", "complete native tail", "native tail", "native tail", "native tail"],
    ["agentMessage", "partial native tail", "native ta", "tail plus", "native tail plus"],
    ["agentMessage", "no overlap", "native tail", "different", null],
    ["reasoning", "complete native tail", "native tail", "native tail", "native tail"],
    ["reasoning", "partial native tail", "native ta", "tail plus", "native tail plus"],
    ["reasoning", "no overlap", "native tail", "different", null],
  ] as const)(
    "aligns %s %s with background text",
    async (type, _name, historical, live, merged) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Pi Session was not opened");
        const readSnapshot = session.readSnapshot.bind(session);
        session.readSnapshot = async () => {
          const snapshot = await readSnapshot();
          if (!snapshot.ok) return snapshot;
          const turns = snapshot.value.turns.map((turn) => ({
            ...turn,
            items: [
              ...turn.items,
              {
                item: { type, itemId: hostItemIdSchema.parse("native-tail"), text: historical },
                outcome: { status: "succeeded" as const },
              },
            ],
          }));
          return { ...snapshot, value: { ...snapshot.value, turns } };
        };
        const itemId = hostItemIdSchema.parse("live-tail");
        const item = { type, itemId, text: live };
        session.emitEvent({ type: "item.background.started", turnId, item });
        await fixture.collector.waitFor((message) => itemStarted(message, itemId));
        const nativeId = type === "reasoning" ? "native-tail-summary" : "native-tail";
        const wireId = type === "reasoning" ? `${itemId}-summary` : itemId;
        for (const request of [5, 6]) {
          if (request === 6) {
            session.emitEvent({
              type: "item.completed",
              turnId,
              snapshot: { item, outcome: { status: "succeeded" } },
            });
            await fixture.collector.waitFor((message) => itemCompleted(message, wireId));
          }
          const items = await readHistoryItems(fixture, threadId, request);
          const native = items.find((entry) => entry.id === nativeId);
          expect(native).toMatchObject(
            type === "reasoning"
              ? { summary: [merged ?? historical] }
              : { text: merged ?? historical },
          );
          expect(items.filter((entry) => entry.id === wireId)).toHaveLength(
            merged === null ? 1 : 0,
          );
        }
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("aligns split live episodes with one continuous replayed text run", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      session.appendText("answer ");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const replayed = {
        input: [{ type: "text" as const, text: "question" }],
        items: [
          {
            item: {
              type: "agentMessage" as const,
              itemId: hostItemIdSchema.parse("turn-0-item-0"),
              text: "answer before restartafter restart",
            },
            outcome: { status: "succeeded" as const },
          },
        ],
      };
      const readSnapshot = session.readSnapshot.bind(session);
      session.readSnapshot = async () => {
        const snapshot = await readSnapshot();
        if (!snapshot.ok) return snapshot;
        return {
          ...snapshot,
          value: {
            ...snapshot.value,
            turns: snapshot.value.turns.map((turn, index) =>
              index === 0
                ? {
                    ...turn,
                    input: replayed.input,
                    items: replayed.items,
                  }
                : turn,
            ),
          },
        };
      };

      for (const [itemId, text] of [
        ["live-before-restart", "before restart"],
        ["live-after-restart", "after restart"],
      ] as const) {
        const item = {
          type: "agentMessage" as const,
          itemId: hostItemIdSchema.parse(itemId),
          text,
        };
        session.emitEvent({ type: "item.background.started", turnId, item });
        await fixture.collector.waitFor((message) => itemStarted(message, itemId));
        if (text === "before restart") {
          session.emitEvent({
            type: "item.completed",
            turnId,
            snapshot: { item, outcome: { status: "succeeded" } },
          });
          await fixture.collector.waitFor((message) => itemCompleted(message, itemId));
        }
      }

      const items = await readHistoryItems(fixture, threadId, 5);
      const agentTexts = items
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.text);
      expect(agentTexts).toEqual(["answer before restartafter restart"]);
      expect(agentTexts.join(" ").match(/before restart/gu)).toHaveLength(1);
      expect(agentTexts.join(" ").match(/after restart/gu)).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([
    ["same content", "same notification", "same notification", false],
    ["same content already replayed", "same notification", "same notification", true],
    ["contained content", "old notification", "notification", false],
    ["contained content already replayed", "old notification", "notification", true],
  ] as const)(
    "keeps an independent %s background Item",
    async (_name, foregroundText, backgroundText, replayed) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId, 2));
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Pi Session was not opened");
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
        session.appendText(foregroundText);
        session.succeedTurn();
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

        const readSnapshot = session.readSnapshot.bind(session);
        session.readSnapshot = async () => {
          const snapshot = await readSnapshot();
          if (!snapshot.ok || !replayed) return snapshot;
          return {
            ...snapshot,
            value: {
              ...snapshot.value,
              turns: snapshot.value.turns.map((turn) => ({
                ...turn,
                items: turn.items.map((entry) =>
                  entry.item.type === "agentMessage"
                    ? { ...entry, item: { ...entry.item, text: entry.item.text + backgroundText } }
                    : entry,
                ),
              })),
            },
          };
        };

        const itemId = hostItemIdSchema.parse("live-independent");
        session.emitEvent({
          type: "item.background.started",
          turnId,
          item: { type: "agentMessage", itemId, text: backgroundText },
        });
        await fixture.collector.waitFor((message) => itemStarted(message, itemId));

        const items = await readHistoryItems(fixture, threadId, 5);
        const agentTexts = items
          .filter((item) => item.type === "agentMessage")
          .map((item) => item.text);
        expect(agentTexts).toEqual(
          replayed ? [foregroundText + backgroundText] : [foregroundText, backgroundText],
        );
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("keeps the historical suffix after a partial replay match", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      session.appendText("foreground");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      const readSnapshot = session.readSnapshot.bind(session);
      session.readSnapshot = async () => {
        const snapshot = await readSnapshot();
        if (!snapshot.ok) return snapshot;
        return {
          ...snapshot,
          value: {
            ...snapshot.value,
            turns: snapshot.value.turns.map((turn) => ({
              ...turn,
              items: [
                {
                  item: {
                    type: "agentMessage" as const,
                    itemId: hostItemIdSchema.parse("native-first"),
                    text: "foreground",
                  },
                  outcome: { status: "succeeded" as const },
                },
                {
                  item: {
                    type: "agentMessage" as const,
                    itemId: hostItemIdSchema.parse("native-second"),
                    text: "prefix ",
                  },
                  outcome: { status: "succeeded" as const },
                },
                {
                  item: {
                    type: "agentMessage" as const,
                    itemId: hostItemIdSchema.parse("native-third"),
                    text: "tail suffix",
                  },
                  outcome: { status: "succeeded" as const },
                },
              ],
            })),
          },
        };
      };

      const itemId = hostItemIdSchema.parse("live-cross-item");
      session.emitEvent({
        type: "item.background.started",
        turnId,
        item: { type: "agentMessage", itemId, text: "prefix tail" },
      });
      await fixture.collector.waitFor((message) => itemStarted(message, itemId));

      const items = await readHistoryItems(fixture, threadId, 5);
      expect(items.filter((item) => item.type === "agentMessage").map((item) => item.text)).toEqual(
        ["foreground", "prefix ", "tail suffix"],
      );
      expect(items.some((item) => item.id === itemId)).toBe(false);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("does not merge a short overlap across a reasoning boundary", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const replayed = {
        input: [{ type: "text" as const, text: "question" }],
        items: [
          {
            item: {
              type: "agentMessage" as const,
              itemId: hostItemIdSchema.parse("turn-0-item-0"),
              text: "task completed",
            },
            outcome: { status: "succeeded" as const },
          },
          {
            item: {
              type: "reasoning" as const,
              itemId: hostItemIdSchema.parse("turn-0-item-1"),
              text: "new episode",
            },
            outcome: { status: "succeeded" as const },
          },
        ],
      };
      const readSnapshot = session.readSnapshot.bind(session);
      session.readSnapshot = async () => {
        const snapshot = await readSnapshot();
        if (!snapshot.ok) return snapshot;
        return {
          ...snapshot,
          value: {
            ...snapshot.value,
            turns: snapshot.value.turns.map((turn, index) =>
              index === 0
                ? {
                    ...turn,
                    input: replayed.input,
                    items: replayed.items,
                  }
                : turn,
            ),
          },
        };
      };

      const item = {
        type: "agentMessage" as const,
        itemId: hostItemIdSchema.parse("live-independent"),
        text: "ed notification",
      };
      session.emitEvent({ type: "item.background.started", turnId, item });
      await fixture.collector.waitFor((message) => itemStarted(message, item.itemId));

      const items = await readHistoryItems(fixture, threadId, 5);
      expect(items.map((entry) => entry.type)).toEqual([
        "userMessage",
        "agentMessage",
        "reasoning",
        "commandExecution",
        "agentMessage",
      ]);
      expect(items[1]?.text).toBe("task completed");
      expect(items[2]?.summary).toEqual(["new episode"]);
      expect(items[3]?.aggregatedOutput).toBe("new episode");
      expect(items[4]?.text).toBe("ed notification");
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([
    ["part-1part-2", ["part-1", "part-2"]],
    ["part-1part-2part-3", ["part-1", "part-2part-3"]],
  ])("preserves reasoning summary segments for %s", async (live, expected) => {
    const alignSnapshot = ExternalThreadRepository.prototype.alignSnapshot;
    const spy = vi
      .spyOn(ExternalThreadRepository.prototype, "alignSnapshot")
      .mockImplementation(async function (this: ExternalThreadRepository, ...args) {
        const aligned = await alignSnapshot.apply(this, args);
        for (const turn of aligned.turns) {
          const item = (turn.items as JsonObject[]).find(
            (entry) => entry.id === "native-tail-summary",
          );
          if (item) item.summary = ["part-1", "part-2"];
        }
        return aligned;
      });
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const readSnapshot = session.readSnapshot.bind(session);
      session.readSnapshot = async () => {
        const snapshot = await readSnapshot();
        if (!snapshot.ok) return snapshot;
        return {
          ...snapshot,
          value: {
            ...snapshot.value,
            turns: snapshot.value.turns.map((turn) => ({
              ...turn,
              items: [
                ...turn.items,
                {
                  item: {
                    type: "reasoning" as const,
                    itemId: hostItemIdSchema.parse("native-tail"),
                    text: "part-1part-2",
                  },
                  outcome: { status: "succeeded" as const },
                },
              ],
            })),
          },
        };
      };
      const itemId = hostItemIdSchema.parse("live-reasoning");
      session.emitEvent({
        type: "item.background.started",
        turnId,
        item: { type: "reasoning", itemId, text: live },
      });
      await fixture.collector.waitFor((message) => itemStarted(message, itemId));
      const items = await readHistoryItems(fixture, threadId, 5);
      expect(items.find((item) => item.id === "native-tail-summary")).toMatchObject({
        summary: expected,
      });
      expect(items.some((item) => item.id === "live-reasoning-summary")).toBe(false);
    } finally {
      spy.mockRestore();
      await stopFixture(fixture);
    }
  });

  it.each([
    ["native tail", "unrelated", "native tail", false],
    ["native overlap", "unrelated", "overlap plus", false],
    ["first text", "other x", "xyz", true],
  ])(
    "matches among history candidates without merging short coincidences",
    async (first, last, live, separate) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Pi Session was not opened");
        const readSnapshot = session.readSnapshot.bind(session);
        session.readSnapshot = async () => {
          const snapshot = await readSnapshot();
          if (!snapshot.ok) return snapshot;
          return {
            ...snapshot,
            value: {
              ...snapshot.value,
              turns: snapshot.value.turns.map((turn) => ({
                ...turn,
                items: [
                  ...turn.items,
                  ...[first, last].map((text, index) => ({
                    item: {
                      type: "agentMessage" as const,
                      itemId: hostItemIdSchema.parse(`native-${index}`),
                      text,
                    },
                    outcome: { status: "succeeded" as const },
                  })),
                ],
              })),
            },
          };
        };
        const itemId = hostItemIdSchema.parse("live-candidate");
        session.emitEvent({
          type: "item.background.started",
          turnId,
          item: { type: "agentMessage", itemId, text: live },
        });
        await fixture.collector.waitFor((message) => itemStarted(message, itemId));
        const items = await readHistoryItems(fixture, threadId, 5);
        expect(items.find((item) => item.id === "native-0")?.text).toBe(
          live === "overlap plus" ? "native overlap plus" : first,
        );
        expect(items.find((item) => item.id === "native-1")?.text).toBe(last);
        expect(items.some((item) => item.id === itemId)).toBe(separate);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("omits an empty background item until its first text arrives", async () => {
    const fixture = createFixture();
    const itemId = hostItemIdSchema.parse("empty-live");
    const backgroundWireItems = CodexTurnProjector.prototype.backgroundWireItems;
    let injectEmpty = true;
    const spy = vi
      .spyOn(CodexTurnProjector.prototype, "backgroundWireItems")
      .mockImplementation(function (this: CodexTurnProjector) {
        const items = new Map(backgroundWireItems.call(this));
        if (injectEmpty) items.set(itemId, { id: itemId, type: "agentMessage", text: "" });
        return items;
      });
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.emitEvent({
        type: "item.background.started",
        turnId,
        item: { type: "agentMessage", itemId, text: "" },
      });
      const marker = hostItemIdSchema.parse("empty-marker");
      session.emitEvent({
        type: "item.background.started",
        turnId,
        item: { type: "reasoning", itemId: marker, text: "marker" },
      });
      await fixture.collector.waitFor((message) => itemStarted(message, marker));
      expect(
        (await readHistoryItems(fixture, threadId, 5)).some((item) => item.id === itemId),
      ).toBe(false);
      injectEmpty = false;
      session.emitEvent({
        type: "item.updated",
        turnId,
        itemId,
        update: { type: "text.append", text: "first" },
      });
      await fixture.collector.waitFor((message) => itemDelta(message, itemId));
      expect(await readHistoryItems(fixture, threadId, 6)).toContainEqual(
        expect.objectContaining({ id: itemId, text: "first" }),
      );
    } finally {
      spy.mockRestore();
      await stopFixture(fixture);
    }
  });

  it("drops the retained Turn projection when a successor Turn starts", async () => {
    const fixture = await createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await completePiTurn(fixture, threadId, 2);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const id = hostTurnIdSchema.parse(turnId);

      const itemId = hostItemIdSchema.parse("bg-item-2");
      session.emitEvent({
        type: "item.background.started",
        turnId: id,
        item: { type: "agentMessage", itemId, text: "" },
      });
      session.emitEvent({
        type: "item.updated",
        turnId: id,
        itemId,
        update: { type: "text.append", text: "pending" },
      });
      await fixture.collector.waitFor((message) => itemStarted(message, itemId));

      // The successor Turn's start retires the old projection; the pending
      // background Item no longer overlays served history afterwards.
      const nextTurnId = await startPiTurn(fixture, threadId, 5);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", nextTurnId));
      session.appendText("answer 5");
      session.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", nextTurnId),
      );
      const items = await readHistoryItems(fixture, threadId, 7);
      const background = items.find((item) => (item as { id?: string }).id === itemId);
      expect((background as { status?: string } | undefined)?.status ?? null).not.toBe(
        "inProgress",
      );
    } finally {
      await stopFixture(fixture);
    }
  });
});
