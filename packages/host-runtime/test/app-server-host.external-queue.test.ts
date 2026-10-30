import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import {
  JsonLineCollector,
  createFixture,
  method,
  messageParams,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const text = (value: string) => [{ type: "text", text: value }];

describe("External Thread follow-up queue", () => {
  it("keeps Desktop queue requests on the Host and starts the next follow-up after a completed Turn", async () => {
    const fixture = createFixture();
    const official = new JsonLineCollector(fixture.official.stdin);
    try {
      const threadId = await startPiThread(fixture);
      const runningTurnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.spyOn(session, "execute");

      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "thread/queue/add",
        params: { threadId, input: text("first"), clientUserMessageId: "message-1" },
      });
      const first = (
        (await fixture.collector.waitFor((message) => requestId(message, 10))).result as {
          queuedSubmission: JsonObject & { id: string };
        }
      ).queuedSubmission;
      expect(first).toEqual({
        id: expect.any(String),
        input: text("first"),
        clientUserMessageId: "message-1",
      });
      await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/queue/changed") && messageParams(message).threadId === threadId,
      );
      writeRequest(fixture.desktopInput, {
        id: 11,
        method: "thread/queue/add",
        params: { threadId, input: text("second"), clientUserMessageId: "message-2" },
      });
      const second = (
        (await fixture.collector.waitFor((message) => requestId(message, 11))).result as {
          queuedSubmission: JsonObject & { id: string };
        }
      ).queuedSubmission;
      writeRequest(fixture.desktopInput, {
        id: 12,
        method: "thread/queue/reorder",
        params: { threadId, queuedSubmissionIds: [second.id] },
      });
      await fixture.collector.waitFor((message) => requestId(message, 12));
      writeRequest(fixture.desktopInput, {
        id: 13,
        method: "thread/queue/update",
        params: { threadId, queuedSubmissionId: second.id, input: text("second edited") },
      });
      await fixture.collector.waitFor((message) => requestId(message, 13));
      writeRequest(fixture.desktopInput, {
        id: 14,
        method: "thread/queue/list",
        params: { threadId, cursor: null, limit: 1 },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 14)),
      ).resolves.toMatchObject({
        result: {
          data: [{ id: second.id, input: text("second edited"), clientUserMessageId: "message-2" }],
          nextCursor: "1",
        },
      });

      session.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", runningTurnId),
      );
      await vi.waitFor(() =>
        expect(execute).toHaveBeenCalledWith(
          expect.objectContaining({ type: "turn.start", input: text("second edited") }),
        ),
      );
      // Desktop renders only its own turn/start input; the queued input arrives with the Turn.
      await expect(
        fixture.collector.waitFor(
          (message) =>
            method(message, "item/started") &&
            (messageParams(message).item as JsonObject).type === "userMessage",
        ),
      ).resolves.toMatchObject({
        params: {
          item: {
            clientId: "message-2",
            content: [{ type: "text", text: "second edited" }],
          },
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 15,
        method: "thread/queue/list",
        params: { threadId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 15)),
      ).resolves.toMatchObject({ result: { data: [{ id: first.id }], nextCursor: null } });

      expect(
        official.messages.some((message) => String(message.method).startsWith("thread/queue/")),
      ).toBe(false);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("pauses after an interrupted Turn until Desktop starts the queued follow-up", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const runningTurnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.spyOn(session, "execute");
      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "thread/queue/add",
        params: { threadId, input: text("after stop"), clientUserMessageId: "message-1" },
      });
      const queued = (
        (await fixture.collector.waitFor((message) => requestId(message, 10))).result as {
          queuedSubmission: JsonObject & { id: string };
        }
      ).queuedSubmission;

      writeRequest(fixture.desktopInput, {
        id: 20,
        method: "turn/interrupt",
        params: { threadId, turnId: runningTurnId },
      });
      await vi.waitFor(() =>
        expect(execute).toHaveBeenCalledWith({ type: "turn.cancel", turnId: runningTurnId }),
      );
      session.completeCancellation();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", runningTurnId),
      );
      writeRequest(fixture.desktopInput, {
        id: 11,
        method: "thread/queue/list",
        params: { threadId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 11)),
      ).resolves.toMatchObject({ result: { data: [{ id: queued.id }] } });
      expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn.start" }));

      writeRequest(fixture.desktopInput, {
        id: 12,
        method: "thread/queue/start",
        params: { threadId, queuedSubmissionId: queued.id },
      });
      const started = await fixture.collector.waitFor((message) => requestId(message, 12));
      expect(started).toMatchObject({ result: { turn: { status: "inProgress" } } });
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ type: "turn.start", input: text("after stop") }),
      );
      writeRequest(fixture.desktopInput, {
        id: 13,
        method: "thread/queue/start",
        params: { threadId, queuedSubmissionId: queued.id },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 13)),
      ).resolves.toMatchObject({ error: { code: -32072 } });
    } finally {
      await stopFixture(fixture);
    }
  });
});
