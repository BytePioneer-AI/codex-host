import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import {
  createFixture,
  messageParams,
  method,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const text = (value: string) => [{ type: "text", text: value }];

it("automatically advances after a definite native refusal, which is safe to replay", async () => {
  const fixture = createFixture();
  fixture.adapter.supportsSteer = true;
  try {
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Missing fake session");
    const execute = vi.spyOn(session, "execute");
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/queue/add",
      params: { threadId, input: text("safe retry"), clientUserMessageId: "safe" },
    });
    await fixture.collector.waitFor((message) => requestId(message, 10));
    execute.mockResolvedValueOnce({
      ok: false,
      error: { code: "invalidState", message: "Input was not taken", retryable: false },
    });
    writeRequest(fixture.desktopInput, {
      id: 20,
      method: "turn/steer",
      params: {
        threadId,
        expectedTurnId: turnId,
        input: text("safe retry"),
        clientUserMessageId: "safe",
        codexhostSteerDelivery: "activeTurn",
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 20)),
    ).resolves.toMatchObject({ error: { code: -32074, message: "Input was not taken" } });
    expect((await fixture.host.clientSnapshot(threadId)).queue?.pausedReason).toBeNull();
    session.succeedTurn();
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ type: "turn.start", input: text("safe retry") }),
      ),
    );
    expect(
      execute.mock.calls.filter(([command]) => (command as { type: string }).type === "turn.start"),
    ).toHaveLength(1);
  } finally {
    await stopFixture(fixture);
  }
});

it("retains an unknown send-now entry for deletion without automatically resending it", async () => {
  const fixture = createFixture();
  fixture.adapter.supportsSteer = true;
  try {
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Missing fake session");
    const execute = vi.spyOn(session, "execute");
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/queue/add",
      params: { threadId, input: text("uncertain"), clientUserMessageId: "uncertain" },
    });
    const added = await fixture.collector.waitFor((message) => requestId(message, 10));
    const item = (added.result as { queuedSubmission: { id: string } }).queuedSubmission;
    execute.mockRejectedValueOnce(new Error("Native input outcome is unknown"));
    expect(
      await fixture.host.handleClientRequest("codexhost/thread/queue/send-now", {
        threadId,
        itemId: item.id,
      }),
    ).toMatchObject({ error: { code: -32074 } });
    expect((await fixture.host.clientSnapshot(threadId)).queue?.pausedReason).toBe(
      "outcome-unknown",
    );
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      execute.mock.calls.filter(([command]) => (command as { type: string }).type === "turn.start"),
    ).toHaveLength(0);
    expect((await fixture.host.clientSnapshot(threadId)).queue).toMatchObject({
      pausedReason: "outcome-unknown",
      items: [{ id: item.id, clientUserMessageId: "uncertain" }],
    });
    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/queue/delete",
      params: { threadId, queuedSubmissionId: item.id },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { deleted: true } });
    expect((await fixture.host.clientSnapshot(threadId)).queue).toMatchObject({
      items: [],
      pausedReason: null,
    });
  } finally {
    await stopFixture(fixture);
  }
});

it.each(["completed", "interrupted"] as const)(
  "does not replay unknown input after a %s Turn or after explicitly selecting another entry",
  async (outcome) => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const originalTurnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fake session");
      const execute = vi.spyOn(session, "execute");
      const request = async (id: number, method: string, params: JsonObject = {}) => {
        writeRequest(fixture.desktopInput, { id, method, params: { threadId, ...params } });
        return fixture.collector.waitFor((message) => requestId(message, id));
      };
      const uncertain = await request(10, "thread/queue/add", {
        input: text("uncertain input"),
        clientUserMessageId: "uncertain",
      });
      const uncertainItem = (uncertain.result as { queuedSubmission: { id: string } })
        .queuedSubmission;
      const other = await request(11, "thread/queue/add", {
        input: text("safe input"),
        clientUserMessageId: "safe",
      });
      const safeItem = (other.result as { queuedSubmission: { id: string } }).queuedSubmission;
      execute.mockRejectedValueOnce(new Error("Native input outcome is unknown"));
      expect(
        await request(20, "turn/steer", {
          expectedTurnId: originalTurnId,
          input: text("uncertain input"),
          clientUserMessageId: "uncertain",
          codexhostSteerDelivery: "activeTurn",
        }),
      ).toMatchObject({ error: { code: -32074 } });
      expect((await fixture.host.clientSnapshot(threadId)).queue).toMatchObject({
        pausedReason: "outcome-unknown",
        items: [{ id: uncertainItem.id }, { id: safeItem.id }],
      });
      const uncertainStarts = () =>
        execute.mock.calls.filter(([command]) => {
          const value = command as { type: string; input?: Array<{ text: string }> };
          return (
            value.type === "turn.start" &&
            value.input?.some((part) => part.text === "uncertain input")
          );
        });
      if (outcome === "completed") session.succeedTurn();
      else {
        await request(21, "turn/interrupt", { turnId: originalTurnId });
        session.completeCancellation();
      }
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", originalTurnId),
      );
      // Allow the completion handler's automatic advancement to settle before negative assertions.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(uncertainStarts(), "unknown input replayed immediately").toHaveLength(0);
      expect((await fixture.host.clientSnapshot(threadId)).queue?.pausedReason).toBe(
        outcome === "completed" ? "outcome-unknown" : "interrupted",
      );

      const started = await request(22, "thread/queue/start", {
        queuedSubmissionId: safeItem.id,
      });
      expect(started).not.toHaveProperty("error");
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ type: "turn.start", input: text("safe input") }),
      );
      const safeTurnId = (started.result as { turn: { id: string } }).turn.id;
      expect((await fixture.host.clientSnapshot(threadId)).queue).toMatchObject({
        pausedReason: "outcome-unknown",
        items: [{ id: uncertainItem.id }],
      });
      session.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", safeTurnId),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(
        uncertainStarts(),
        "sending a DIFFERENT entry automatically replayed unknown input",
      ).toHaveLength(0);
      expect((await fixture.host.clientSnapshot(threadId)).queue?.pausedReason).toBe(
        "outcome-unknown",
      );
      expect(await request(23, "thread/queue/list")).toMatchObject({
        result: { data: [{ id: uncertainItem.id, clientUserMessageId: "uncertain" }] },
      });
      const uncertainMessages = () =>
        fixture.collector.messages.filter(
          (message) =>
            method(message, "item/started") &&
            (messageParams(message).item as JsonObject).clientId === "uncertain",
        );
      expect(uncertainMessages()).toHaveLength(0);

      // Explicitly selecting the uncertain entry remains a user-controlled retry.
      expect(
        await request(24, "thread/queue/start", { queuedSubmissionId: uncertainItem.id }),
      ).not.toHaveProperty("error");
      await vi.waitFor(() => expect(uncertainMessages()).toHaveLength(1));
      expect(uncertainStarts()).toHaveLength(1);
      expect(await request(25, "thread/queue/list")).toMatchObject({ result: { data: [] } });
      expect((await fixture.host.clientSnapshot(threadId)).queue?.pausedReason).toBeNull();
    } finally {
      await stopFixture(fixture);
    }
  },
);
