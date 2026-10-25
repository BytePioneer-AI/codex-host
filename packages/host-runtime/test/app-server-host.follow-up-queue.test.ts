import { describe, expect, it } from "vitest";

import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("external follow-up queue", () => {
  it("starts a queued follow-up from thread/queue/start and from an empty turn/start", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/queue/add",
        params: {
          threadId,
          clientUserMessageId: "follow-up",
          input: [{ type: "text", text: "queued from overlay" }],
        },
      });
      const added = await fixture.collector.waitFor((message) => requestId(message, 2));
      expect(added.error).toBeUndefined();
      expect(added.result).toMatchObject({
        queuedSubmission: { clientUserMessageId: "follow-up" },
      });

      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "thread/queue/start",
        params: {
          threadId,
          queuedSubmissionId: (added.result as { queuedSubmission: { id: string } })
            .queuedSubmission.id,
        },
      });
      const started = await fixture.collector.waitFor((message) => requestId(message, 3));
      expect(started.error).toBeUndefined();
      const turnId = (started.result as { turn: { id: string } }).turn.id;
      expect(turnId).toBeTruthy();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      fixture.adapter.sessions[0]?.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "thread/queue/add",
        params: {
          threadId,
          clientUserMessageId: "empty-start",
          input: [{ type: "text", text: "resume after interrupt" }],
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 4));
      writeRequest(fixture.desktopInput, {
        id: 5,
        method: "turn/start",
        params: { threadId, clientUserMessageId: "empty-start", input: [] },
      });
      const resumed = await fixture.collector.waitFor((message) => requestId(message, 5));
      expect(resumed.error).toBeUndefined();
      expect(resumed.result).toMatchObject({ turn: { status: "inProgress" } });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("resumes an interrupted Thread and starts the queued follow-up from Desktop's empty turn/start", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId, 2);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "turn/interrupt",
        params: { threadId, turnId },
      });
      await fixture.collector.waitFor((message) => requestId(message, 3));
      session.completeCancellation();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "thread/resume",
        params: { threadId, excludeTurns: true },
      });
      const resume = await fixture.collector.waitFor((message) => requestId(message, 4));
      expect(resume.error).toBeUndefined();
      expect(resume.result).toMatchObject({ thread: { id: threadId } });

      writeRequest(fixture.desktopInput, {
        id: 5,
        method: "thread/queue/add",
        params: {
          threadId,
          clientUserMessageId: "after-resume",
          input: [{ type: "text", text: "queued after interrupt" }],
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 5));
      writeRequest(fixture.desktopInput, {
        id: 6,
        method: "turn/start",
        params: { threadId, clientUserMessageId: "after-resume", input: [] },
      });
      const started = await fixture.collector.waitFor((message) => requestId(message, 6));
      expect(started.error).toBeUndefined();
      expect(started.result).toMatchObject({ turn: { status: "inProgress" } });
    } finally {
      await stopFixture(fixture);
    }
  });
});
