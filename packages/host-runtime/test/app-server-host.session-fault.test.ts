import { describe, expect, it, vi } from "vitest";
import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  threadStatus,
  turnEvent,
} from "./app-server-host-fixture.js";

describe("AppServerHost session fault", () => {
  it("fails an open Turn when the Session faults without a terminal event", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const close = vi.spyOn(session, "close");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const reasoningId = session.startReasoning("still thinking");
      session.emitEvent({
        type: "session.faulted",
        error: {
          code: "unavailable",
          message: "Aqua Harness broker connection closed",
          retryable: true,
        },
      });
      const completed = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      expect(completed).toMatchObject({
        params: {
          turn: {
            status: "failed",
            error: { message: "Aqua Harness broker connection closed" },
          },
        },
      });
      await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));
      expect(fixture.collector.messages).toContainEqual(
        expect.objectContaining({
          method: "item/completed",
          params: expect.objectContaining({
            item: expect.objectContaining({ id: `${reasoningId}-summary`, type: "reasoning" }),
          }),
        }),
      );
      expect(
        fixture.collector.messages.filter((message) =>
          turnEvent(message, "turn/completed", turnId),
        ),
      ).toHaveLength(1);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    } finally {
      await stopFixture(fixture);
    }
  });

  it("does not complete a Turn twice when the Session already finished it", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      session.fault({
        code: "nativeFailure",
        message: "Native Session faulted",
        retryable: false,
      });
      const completed = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      expect(completed).toMatchObject({
        params: {
          turn: { status: "failed", error: { message: "Native Session faulted" } },
        },
      });
      await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));
      expect(
        fixture.collector.messages.filter((message) =>
          turnEvent(message, "turn/completed", turnId),
        ),
      ).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });
});
