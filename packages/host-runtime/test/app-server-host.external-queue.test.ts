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

  it.each(["turn/steer", "turn/start"] as const)(
    "consumes a queued %s replacement before it can auto-start twice",
    async (submissionMethod) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = await startPiTurn(fixture, threadId);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Session was not opened");
        const execute = vi.spyOn(session, "execute");
        const queued = [];
        for (const [index, value] of ["replacement", "next"].entries()) {
          writeRequest(fixture.desktopInput, {
            id: 10 + index,
            method: "thread/queue/add",
            params: { threadId, input: text(value), clientUserMessageId: `message-${index}` },
          });
          const added = await fixture.collector.waitFor((message) =>
            requestId(message, 10 + index),
          );
          queued.push((added.result as { queuedSubmission: { id: string } }).queuedSubmission);
        }
        writeRequest(fixture.desktopInput, {
          id: 20,
          method: submissionMethod,
          params: {
            threadId,
            input: text("replacement"),
            clientUserMessageId: "message-0",
            ...(submissionMethod === "turn/start"
              ? {
                  additionalContext: {
                    codexhost_external_steering: {
                      kind: "application",
                      value: JSON.stringify({
                        expectedTurnId: turnId,
                        clientUserMessageId: "message-0",
                        delivery: "newTurn",
                      }),
                    },
                  },
                }
              : { expectedTurnId: turnId, codexhostSteerDelivery: "newTurn" }),
          },
        });
        await vi.waitFor(() =>
          expect(execute).toHaveBeenCalledWith({ type: "turn.cancel", turnId }),
        );
        session.completeCancellation();
        const steered = await fixture.collector.waitFor((message) => requestId(message, 20));
        expect(steered).not.toHaveProperty("error");
        const replacementId =
          submissionMethod === "turn/start"
            ? (steered.result as { turn: { id: string } }).turn.id
            : (steered.result as { turnId: string }).turnId;
        // Desktop has not yet sent thread/queue/delete for its successful steer.
        session.succeedTurn();
        await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/completed", replacementId),
        );
        await vi.waitFor(() =>
          expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({ type: "turn.start", input: text("next") }),
          ),
        );
        expect(
          execute.mock.calls.filter(([command]) => {
            const value = command as { type: string; input?: unknown };
            return (
              value.type === "turn.start" &&
              JSON.stringify(value.input) === JSON.stringify(text("replacement"))
            );
          }),
        ).toHaveLength(1);
        const first = queued[0];
        if (!first) throw new Error("Queued submission was not created");
        writeRequest(fixture.desktopInput, {
          id: 21,
          method: "thread/queue/delete",
          params: { threadId, queuedSubmissionId: first.id },
        });
        await expect(
          fixture.collector.waitFor((message) => requestId(message, 21)),
        ).resolves.toMatchObject({ result: { deleted: true } });
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it.each(["client", "delivery", "json", "turn"])(
    "rejects an invalid native start marker (%s) before execution",
    async (invalid) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = await startPiTurn(fixture, threadId);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Session was not opened");
        const execute = vi.spyOn(session, "execute");
        const marker = {
          expectedTurnId: invalid === "turn" ? "stale" : turnId,
          clientUserMessageId: invalid === "client" ? "other" : "message",
          delivery: invalid === "delivery" ? "activeTurn" : "newTurn",
        };
        writeRequest(fixture.desktopInput, {
          id: 20,
          method: "turn/start",
          params: {
            threadId,
            input: text("keep input"),
            clientUserMessageId: "message",
            additionalContext: {
              codexhost_external_steering: {
                kind: "application",
                value: invalid === "json" ? "invalid-json" : JSON.stringify(marker),
              },
            },
          },
        });
        await expect(
          fixture.collector.waitFor((message) => requestId(message, 20)),
        ).resolves.toMatchObject({ error: { code: invalid === "turn" ? -32074 : -32602 } });
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("restores a queued submission when steering is rejected before acceptance", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.spyOn(session, "execute");
      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "thread/queue/add",
        params: { threadId, input: text("keep queued"), clientUserMessageId: "message" },
      });
      const added = await fixture.collector.waitFor((message) => requestId(message, 10));
      const submission = (added.result as { queuedSubmission: JsonObject }).queuedSubmission;
      writeRequest(fixture.desktopInput, {
        id: 20,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: "stale-turn",
          input: text("keep queued"),
          clientUserMessageId: "message",
        },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 20)),
      ).resolves.toMatchObject({ error: { code: -32074 } });
      writeRequest(fixture.desktopInput, {
        id: 21,
        method: "thread/queue/list",
        params: { threadId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 21)),
      ).resolves.toMatchObject({ result: { data: [submission], nextCursor: null } });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["completed", "interrupted", "failed"])(
    "handles a queue/add arriving after the Turn is already %s",
    async (outcome) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = await startPiTurn(fixture, threadId);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Session was not opened");
        const execute = vi.spyOn(session, "execute");
        if (outcome === "completed") session.succeedTurn();
        else if (outcome === "failed")
          session.failTurn({ code: "internalError", message: "Fixture failure", retryable: false });
        else {
          writeRequest(fixture.desktopInput, {
            id: 9,
            method: "turn/interrupt",
            params: { threadId, turnId },
          });
          await fixture.collector.waitFor((message) => requestId(message, 9));
          session.completeCancellation();
        }
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        // Let the completion handler finish its empty-queue check before the delayed request.
        await new Promise<void>((resolve) => setImmediate(resolve));
        writeRequest(fixture.desktopInput, {
          id: 10,
          method: "thread/queue/add",
          params: { threadId, input: text("late follow-up"), clientUserMessageId: "late-message" },
        });
        const added = await fixture.collector.waitFor((message) => requestId(message, 10));
        expect(added).not.toHaveProperty("error");
        if (outcome === "completed") {
          await vi.waitFor(() =>
            expect(execute).toHaveBeenCalledWith(
              expect.objectContaining({ type: "turn.start", input: text("late follow-up") }),
            ),
          );
        } else {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn.start" }));
        }
      } finally {
        await stopFixture(fixture);
      }
    },
  );

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
