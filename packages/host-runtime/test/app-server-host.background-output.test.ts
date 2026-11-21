import { describe, expect, it, vi } from "vitest";
import type { HostTurnSnapshot } from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  REASONING_TRANSCRIPT_COMMAND,
} from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";

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
  return (await readHistoryTurns(fixture, threadId, id)).flatMap(
    (turn) => (turn.items ?? []) as JsonObject[],
  );
}

async function readHistoryTurns(
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
  return (thread.turns ?? []) as JsonObject[];
}

function wakeSnapshot(source: HostTurnSnapshot, key: string): HostTurnSnapshot {
  return {
    nativeTurnRef: { ...source.nativeTurnRef, nativeTurnKey: key },
    input: [],
    items: [
      {
        item: { type: "agentMessage", itemId: hostItemIdSchema.parse(key), text: key },
        outcome: { status: "succeeded" },
      },
    ],
    outcome: { status: "succeeded" },
  };
}

describe("Host runtime idle background output on a completed Turn", () => {
  it("restores pre-submit background text from history after a successor starts", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      await completePiTurn(fixture, threadId, 2);
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
            turns: snapshot.value.turns.map((turn, index) =>
              index === 0
                ? {
                    ...turn,
                    items: [
                      ...turn.items,
                      {
                        item: {
                          type: "agentMessage" as const,
                          itemId: hostItemIdSchema.parse("native-pre-submit-wake"),
                          text: "wake from native history",
                        },
                        outcome: { status: "succeeded" as const },
                      },
                    ],
                  }
                : turn,
            ),
          },
        };
      };

      const successorTurnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId, 3));
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/started", successorTurnId),
      );
      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "turn/interrupt",
        params: { threadId, turnId: successorTurnId },
      });
      expect(
        await fixture.collector.waitFor((message) => requestId(message, 4)),
      ).not.toHaveProperty("error");
      session.completeCancellation();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", successorTurnId),
      );
      const turns = await readHistoryTurns(fixture, threadId, 5);
      const wakeItems = turns
        .flatMap((turn) => (turn.items ?? []) as JsonObject[])
        .filter((item) => item.type === "agentMessage" && item.text === "wake from native history");
      expect(wakeItems).toHaveLength(1);
      expect(turns[0]?.items).toContainEqual(
        expect.objectContaining({ text: "wake from native history" }),
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("streams a background Item on a completed Turn and overlays it onto served history", async () => {
    const fixture = await createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await completePiTurn(fixture, threadId, 2);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");

      const readMetadata = async (request: number) => {
        writeRequest(fixture.desktopInput, {
          id: request,
          method: "thread/read",
          params: { threadId, includeTurns: false },
        });
        const reply = await fixture.collector.waitFor((message) => requestId(message, request));
        return (reply.result as { thread: { updatedAt: number; recencyAt: number } }).thread;
      };
      const before = await readMetadata(3);
      using clock = vi.spyOn(Date, "now");
      clock.mockReturnValue((before.updatedAt + 2) * 1_000);
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
      expect(await readMetadata(4)).toMatchObject({
        updatedAt: before.updatedAt + 2,
        recencyAt: before.updatedAt + 2,
      });

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

  it("projects background output queued after a Session fault onto its completed Turn", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const itemId = hostItemIdSchema.parse("buffered-background-output");
      session.emitEvent({
        type: "session.faulted",
        error: { code: "unavailable", message: "Connection closed", retryable: true },
      });
      session.emitEvent({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
      session.emitEvent({
        type: "item.background.started",
        turnId,
        item: { type: "agentMessage", itemId, text: "" },
      });
      session.emitEvent({
        type: "item.updated",
        turnId,
        itemId,
        update: { type: "text.append", text: "buffered output" },
      });
      session.emitEvent({
        type: "item.completed",
        turnId,
        snapshot: {
          item: { type: "agentMessage", itemId, text: "buffered output" },
          outcome: { status: "succeeded" },
        },
      });
      const completed = await fixture.collector.waitFor((message) =>
        itemCompleted(message, itemId),
      );
      expect(completed.params).toMatchObject({
        turnId,
        item: { id: itemId, text: "buffered output" },
      });
      expect(
        fixture.collector.messages.filter((message) =>
          turnEvent(message, "turn/completed", turnId),
        ),
      ).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([false, true])(
    "preserves native Items and settled background text during a successor Turn (already persisted: %s)",
    async (persisted) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Pi Session was not opened");
        const readSnapshot = session.readSnapshot.bind(session);
        const nativeItems = [
          {
            type: "reasoning",
            itemId: hostItemIdSchema.parse("native-reasoning"),
            text: "analysis",
          },
          {
            type: "toolExecution",
            itemId: hostItemIdSchema.parse("native-tool"),
            toolName: "lookup",
            arguments: {},
          },
          ...(persisted
            ? [
                {
                  type: "agentMessage" as const,
                  itemId: hostItemIdSchema.parse("native-wake"),
                  text: "wake",
                },
              ]
            : []),
        ] as const;
        session.readSnapshot = async () => {
          const snapshot = await readSnapshot();
          if (!snapshot.ok) return snapshot;
          const turns = snapshot.value.turns.map((turn) => ({
            ...turn,
            items: [
              ...turn.items,
              ...nativeItems.map((item) => ({ item, outcome: { status: "succeeded" as const } })),
            ],
          }));
          return { ...snapshot, value: { ...snapshot.value, turns } };
        };
        const transcript = expect.objectContaining({
          id: "native-reasoning",
          command: REASONING_TRANSCRIPT_COMMAND,
          aggregatedOutput: "analysis",
        });
        const tool = expect.objectContaining({ id: "native-tool", type: "dynamicToolCall" });
        expect(await readHistoryItems(fixture, threadId, 3)).toEqual(
          expect.arrayContaining([transcript, tool]),
        );

        const itemId = hostItemIdSchema.parse("live-wake");
        const item = { type: "agentMessage" as const, itemId, text: "wake" };
        session.emitEvent({ type: "item.background.started", turnId, item });
        await fixture.collector.waitFor((message) => itemStarted(message, itemId));
        session.emitEvent({
          type: "item.completed",
          turnId,
          snapshot: { item, outcome: { status: "succeeded" } },
        });
        const successor = await startPiTurn(fixture, threadId, 4);
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", successor));
        const [first, second] = await readHistoryTurns(fixture, threadId, 5);
        expect(second).toMatchObject({ id: successor, status: "inProgress" });
        const items = (first?.items ?? []) as JsonObject[];
        expect(items).toEqual(expect.arrayContaining([transcript, tool]));
        expect(
          items.filter((entry) => entry.type === "agentMessage" && entry.text === "wake"),
        ).toEqual([expect.objectContaining({ id: persisted ? "native-wake" : itemId })]);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

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
    "keeps the settled detached command's Turn eligible for background output only without a successor (%s)",
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
        const lateId = hostItemIdSchema.parse("old-late");
        session.emitEvent({
          type: "item.background.started",
          turnId,
          item: { type: "agentMessage", itemId: lateId, text: "late" },
        });
        if (successor) {
          await vi.waitFor(() => {
            expect(fixture.diagnosticOutput.read()?.toString() ?? "").toContain(
              "unknown Host Turn",
            );
          });
        } else {
          const started = await fixture.collector.waitFor((message) =>
            itemStarted(message, lateId),
          );
          expect(started.params).toMatchObject({ turnId });
        }
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
    ["reasoning", "one-character prefix", "T", "T1", "T1"],
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
          if (type === "reasoning" && historical === "T") {
            expect(items.find((entry) => entry.id === "native-tail")).toMatchObject({
              aggregatedOutput: merged,
            });
          }
          expect(items.filter((entry) => entry.id === wireId)).toHaveLength(
            merged === null ? 1 : 0,
          );
        }
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it.each(["after restart", "a"])("aligns replayed text ending in %j", async (tail) => {
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
              text: `answer before restart${tail}`,
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

  it("aligns alternating replayed reasoning and text Items without duplicating them", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const replayed = [
        {
          type: "agentMessage" as const,
          itemId: hostItemIdSchema.parse("turn-0-item-0"),
          text: "answer 2",
        },
        {
          type: "reasoning" as const,
          itemId: hostItemIdSchema.parse("turn-0-item-1"),
          text: "T1",
        },
        {
          type: "agentMessage" as const,
          itemId: hostItemIdSchema.parse("turn-0-item-2"),
          text: "A1",
        },
        {
          type: "reasoning" as const,
          itemId: hostItemIdSchema.parse("turn-0-item-3"),
          text: "T2",
        },
        {
          type: "agentMessage" as const,
          itemId: hostItemIdSchema.parse("turn-0-item-4"),
          text: "A2",
        },
      ];
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
              items: replayed.map((item) => ({
                item,
                outcome: { status: "succeeded" as const },
              })),
            })),
          },
        };
      };

      for (const [index, [type, text]] of (
        [
          ["reasoning", "T1"],
          ["agentMessage", "A1"],
          ["reasoning", "T2"],
          ["agentMessage", "A2"],
        ] as const
      ).entries()) {
        const itemId = hostItemIdSchema.parse(`live-alternating-${index}`);
        session.emitEvent({
          type: "item.background.started",
          turnId,
          item: { type, itemId, text },
        });
        await fixture.collector.waitFor((message) => itemStarted(message, itemId));
      }

      const items = await readHistoryItems(fixture, threadId, 5);
      expect(items.filter((item) => item.type === "agentMessage").map((item) => item.text)).toEqual(
        ["answer 2", "A1", "A2"],
      );
      expect(items.filter((item) => item.type === "reasoning").map((item) => item.summary)).toEqual(
        [["T1"], ["T2"]],
      );
      expect(items.filter((item) => String(item.id).startsWith("live-alternating"))).toHaveLength(
        0,
      );
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

  it("extends merged replayed reasoning and its transcript before the next background Item", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const reasoningId = session.startReasoning("analysis: ");
      session.completeItem(reasoningId, { status: "succeeded" });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const readSnapshot = session.readSnapshot.bind(session);
      session.readSnapshot = async () => {
        const snapshot = await readSnapshot();
        if (!snapshot.ok) return snapshot;
        const turns = snapshot.value.turns.map((turn) => ({
          ...turn,
          items: turn.items.map((entry) =>
            entry.item.type === "reasoning"
              ? { ...entry, item: { ...entry.item, text: "analysis: ta" } }
              : entry,
          ),
        }));
        return { ...snapshot, value: { ...snapshot.value, turns } };
      };
      for (const [index, text] of ["tail", "il again"].entries()) {
        const itemId = hostItemIdSchema.parse(`live-overlap-${index}`);
        session.emitEvent({
          type: "item.background.started",
          turnId,
          item: { type: "reasoning", itemId, text },
        });
        await fixture.collector.waitFor((message) => itemStarted(message, itemId));
      }
      const items = await readHistoryItems(fixture, threadId, 3);
      expect(items.filter((item) => item.type === "reasoning").map((item) => item.summary)).toEqual(
        [["analysis: tail"], ["il again"]],
      );
      expect(
        items.find((item) => item.command === REASONING_TRANSCRIPT_COMMAND)?.aggregatedOutput,
      ).toBe("analysis: tail");
    } finally {
      await stopFixture(fixture);
    }
  });

  it("preserves multiple replayed reasoning Items without duplicating them", async () => {
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
                ...["part-1", "part-2"].map((text, index) => ({
                  item: {
                    type: "reasoning" as const,
                    itemId: hostItemIdSchema.parse(`native-tail-${index}`),
                    text,
                  },
                  outcome: { status: "succeeded" as const },
                })),
              ],
            })),
          },
        };
      };
      for (const [index, text] of ["part-1", "part-2"].entries()) {
        const itemId = hostItemIdSchema.parse(`live-reasoning-${index}`);
        session.emitEvent({
          type: "item.background.started",
          turnId,
          item: { type: "reasoning", itemId, text },
        });
        await fixture.collector.waitFor((message) => itemStarted(message, itemId));
      }
      const items = await readHistoryItems(fixture, threadId, 5);
      expect(items.filter((item) => item.type === "reasoning").map((item) => item.summary)).toEqual(
        [["part-1"], ["part-2"]],
      );
      expect(items.some((item) => String(item.id).startsWith("live-reasoning"))).toBe(false);
    } finally {
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
      expect(background).toMatchObject({ id: itemId, text: "pending" });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("appends a committed autonomous Turn without touching the previous final answer", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      await completePiTurn(fixture, threadId, 2);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const [before] = await readHistoryTurns(fixture, threadId, 3);
      const [first] = session.persistedSnapshot().turns;
      if (!first) throw new Error("Missing persisted user Turn");
      const wake = {
        nativeTurnRef: { ...first.nativeTurnRef, nativeTurnKey: "wake-12" },
        input: [],
        items: [
          {
            item: {
              type: "subagentDelegation" as const,
              itemId: hostItemIdSchema.parse("wake-child"),
              operation: "spawn" as const,
              subagents: [
                {
                  subagentId: "native-wake-child",
                  nativeSubagentId: "native-wake-child",
                  description: "Check timer",
                  background: false,
                  status: "completed" as const,
                },
              ],
            },
            outcome: { status: "succeeded" as const },
          },
          {
            item: {
              type: "agentMessage" as const,
              itemId: hostItemIdSchema.parse("wake-reply"),
              text: "Timer expired",
            },
            outcome: { status: "succeeded" as const },
          },
        ],
        outcome: { status: "unknown" as const, reason: "Native stop reason is not recorded" },
      };
      const originalRead = session.readSnapshot.bind(session);
      session.readSnapshot = async () => {
        const result = await originalRead();
        if (result.ok) result.value.turns.splice(1, 0, wake);
        return result;
      };
      session.emitEvent({ type: "turn.autonomous.completed", snapshot: wake });
      const item = await fixture.collector.waitFor((message) =>
        itemCompleted(message, "wake-reply"),
      );
      const id = (item.params as { turnId: string }).turnId;
      const live = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", id),
      );
      const projected = (live.params as { turn: JsonObject }).turn;
      expect(projected.items).toMatchObject([
        {
          id: "wake-child",
          type: "collabAgentToolCall",
          senderThreadId: threadId,
          receiverThreadIds: [expect.stringMatching(/^[\da-f-]{36}$/u)],
        },
        { id: "wake-reply", type: "agentMessage", text: "Timer expired", phase: "final_answer" },
      ]);
      // A read before a duplicate notification already knows this native Turn.
      expect(await readHistoryTurns(fixture, threadId, 4)).toEqual([before, projected]);
      session.emitEvent({ type: "turn.autonomous.completed", snapshot: wake });
      await completePiTurn(fixture, threadId, 5);
      expect((await readHistoryTurns(fixture, threadId, 6)).slice(0, 2)).toEqual([
        before,
        projected,
      ]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["mapping write", "projection"])(
    "keeps the foreground Turn and output stream alive after an autonomous %s failure",
    async (stage) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        await completePiTurn(fixture, threadId, 2);
        const session = fixture.adapter.sessions[0];
        const first = session?.persistedSnapshot().turns[0];
        if (!session || !first) throw new Error("Missing persisted user Turn");
        const foreground = await startPiTurn(fixture, threadId, 3);
        await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/started", foreground),
        );
        const wake = wakeSnapshot(first, "wake-failed");
        const failure = new Error(`injected autonomous ${stage} failure`);
        if (stage === "mapping write") {
          vi.spyOn(fixture.mappingStore, "upsertTurnMappings").mockRejectedValueOnce(failure);
        } else {
          wake.items.unshift({
            item: {
              type: "subagentDelegation",
              itemId: hostItemIdSchema.parse("wake-child"),
              operation: "spawn",
              subagents: [
                {
                  subagentId: "wake-child",
                  nativeSubagentId: "wake-child",
                  description: "Timer worker",
                  background: false,
                  status: "completed",
                },
              ],
            },
            outcome: { status: "succeeded" },
          });
          vi.spyOn(fixture.mappingStore, "createProvisional").mockRejectedValueOnce(failure);
        }
        const diagnostic = new Promise<string>((resolve) =>
          fixture.diagnosticOutput.once("data", (chunk: Buffer) => resolve(chunk.toString())),
        );
        session.emitEvent({ type: "turn.autonomous.completed", snapshot: wake });
        session.appendText("foreground finished normally");
        session.succeedTurn();
        const done = await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/completed", foreground),
        );
        expect(done.params).toMatchObject({ turn: { status: "completed" } });
        expect(await diagnostic).toContain(failure.message);
        expect(fixture.collector.messages).toContainEqual(
          expect.objectContaining({
            method: "item/completed",
            params: expect.objectContaining({
              turnId: foreground,
              item: expect.objectContaining({ text: "foreground finished normally" }),
            }),
          }),
        );
        session.emitEvent({
          type: "turn.autonomous.completed",
          snapshot: wakeSnapshot(first, "wake-next"),
        });
        await fixture.collector.waitFor((message) => itemCompleted(message, "wake-next"));
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("reconciles a missed older wake when live output overlaps a history read", async () => {
    const fixture = createFixture();
    const readStarted = Promise.withResolvers<undefined>();
    const finishRead = Promise.withResolvers<undefined>();
    try {
      const threadId = await startPiThread(fixture);
      await completePiTurn(fixture, threadId, 2);
      const session = fixture.adapter.sessions[0];
      const first = session?.persistedSnapshot().turns[0];
      if (!session || !first) throw new Error("Missing persisted user Turn");
      const earlier = wakeSnapshot(first, "wake-earlier");
      const later = wakeSnapshot(first, "wake-later");
      const originalRead = session.readSnapshot.bind(session);
      let liveWakeCommitted = false;
      session.readSnapshot = async () => {
        const result = await originalRead();
        if (!result.ok) return result;
        result.value.turns.push(earlier);
        if (liveWakeCommitted) result.value.turns.push(later);
        else {
          readStarted.resolve(undefined);
          await finishRead.promise;
        }
        return result;
      };
      const history = readHistoryTurns(fixture, threadId, 3);
      await readStarted.promise;
      liveWakeCommitted = true;
      session.emitEvent({ type: "turn.autonomous.completed", snapshot: later });
      const live = await fixture.collector.waitFor((message) =>
        itemCompleted(message, "wake-later"),
      );
      finishRead.resolve(undefined);
      const turns = await history;
      expect(turns.map(({ items }) => (items as JsonObject[]).at(-1)?.text)).toEqual([
        "answer 2",
        "wake-earlier",
        "wake-later",
      ]);
      expect(turns.at(-1)?.id).toBe((live.params as { turnId: string }).turnId);
    } finally {
      finishRead.resolve(undefined);
      await stopFixture(fixture);
    }
  });

  it("promotes a trailing idle background agentMessage to final_answer and demotes the earlier answer", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await completePiTurn(fixture, threadId, 2));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");

      const beforeItems = await readHistoryItems(fixture, threadId, 3);
      const initialAnswer = beforeItems.find((item) => item.type === "agentMessage");
      expect(initialAnswer).toMatchObject({ phase: "final_answer" });

      const bgId = hostItemIdSchema.parse("bg-final-reply");
      session.emitEvent({
        type: "item.background.started",
        turnId,
        item: { type: "agentMessage", itemId: bgId, text: "" },
      });
      session.emitEvent({
        type: "item.updated",
        turnId,
        itemId: bgId,
        update: { type: "text.append", text: "background task finished" },
      });
      session.emitEvent({
        type: "item.completed",
        turnId,
        snapshot: {
          item: { type: "agentMessage", itemId: bgId, text: "background task finished" },
          outcome: { status: "succeeded" },
        },
      });
      await fixture.collector.waitFor((message) => itemCompleted(message, bgId));

      const afterItems = await readHistoryItems(fixture, threadId, 4);
      const agentMessages = afterItems.filter((item) => item.type === "agentMessage");
      expect(agentMessages).toHaveLength(2);
      expect(agentMessages[0]).toMatchObject({ id: initialAnswer?.id, phase: null });
      expect(agentMessages[1]).toMatchObject({
        id: bgId,
        text: "background task finished",
        phase: "final_answer",
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
