import { describe, expect, it } from "vitest";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
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
  writeRequest(fixture.desktopInput, {
    id,
    method: "thread/read",
    params: { threadId, includeTurns: true },
  });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  const thread = ((response.result ?? {}) as JsonObject).thread as JsonObject;
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
