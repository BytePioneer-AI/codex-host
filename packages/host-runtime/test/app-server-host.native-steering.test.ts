import { describe, expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import {
  createFixture,
  method,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

function steeredUserMessage(message: JsonObject, turnId: string): JsonObject | null {
  if (!method(message, "item/started")) return null;
  const params = message.params as JsonObject;
  const item = params.item as JsonObject;
  return params.turnId === turnId && item.type === "userMessage" ? item : null;
}

describe("Native steering", () => {
  it("takes a Desktop steer into the active Turn and settles Desktop's optimistic message", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");

      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "codexhost/thread/steering/inspect",
        params: { threadId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 10)),
      ).resolves.toMatchObject({ result: { delivery: "activeTurn" } });

      writeRequest(fixture.desktopInput, {
        id: 11,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: "desktop-message",
          input: [{ type: "text", text: "also check the tests" }],
        },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 11)),
      ).resolves.toMatchObject({ result: { turnId, delivery: "activeTurn" } });
      const item = await fixture.collector.waitFor(
        (message) => steeredUserMessage(message, turnId) !== null,
      );
      expect(steeredUserMessage(item, turnId)).toMatchObject({
        clientId: "desktop-message",
        content: [{ type: "text", text: "also check the tests" }],
      });
      expect(session.steers).toEqual([expect.objectContaining({ type: "turn.steer", turnId })]);

      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("refuses Fork and undo of a steered Turn until Desktop rereads the Thread", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");

      writeRequest(fixture.desktopInput, {
        id: 11,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: "also check the tests" }],
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 11));
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      writeRequest(fixture.desktopInput, {
        id: 12,
        method: "thread/fork",
        params: { threadId, lastTurnId: turnId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 12)),
      ).resolves.toMatchObject({ error: { code: -32080 } });
      writeRequest(fixture.desktopInput, {
        id: 13,
        method: "thread/rollback",
        params: { threadId, numTurns: 1 },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 13)),
      ).resolves.toMatchObject({ error: { code: -32080 } });
      expect(fixture.adapter.sessions).toHaveLength(1);

      writeRequest(fixture.desktopInput, { id: 14, method: "thread/resume", params: { threadId } });
      await fixture.collector.waitFor((message) => requestId(message, 14));
      writeRequest(fixture.desktopInput, {
        id: 15,
        method: "thread/fork",
        params: { threadId, lastTurnId: turnId },
      });
      const forked = await fixture.collector.waitFor((message) => requestId(message, 15));
      expect(forked).not.toHaveProperty("error");
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reports replacement mode for a Session without native steering", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      await startPiTurn(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "codexhost/thread/steering/inspect",
        params: { threadId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 10)),
      ).resolves.toMatchObject({ result: { delivery: "newTurn" } });
    } finally {
      await stopFixture(fixture);
    }
  });
});
