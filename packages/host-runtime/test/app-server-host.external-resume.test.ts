import { describe, expect, it } from "vitest";

import { EXTERNAL_RESUME_INTERRUPTED_UNSUPPORTED } from "../src/external-turn-input.js";
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

describe("External Thread resume of an interrupted Turn", () => {
  it("explains that Desktop's inputless resume is unsupported without starting a Turn", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId, 2);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.completeCancellationOnRequest();
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "turn/interrupt",
        params: { threadId, turnId },
      });
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const started = fixture.collector.messages.filter((message) =>
        method(message, "turn/started"),
      ).length;

      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "turn/start",
        params: { threadId, input: [], turnTrigger: "resume_interrupted_task" },
      });

      await expect(
        fixture.collector.waitFor((message) => requestId(message, 4)),
      ).resolves.toMatchObject({
        error: { code: -32078, message: EXTERNAL_RESUME_INTERRUPTED_UNSUPPORTED },
      });
      expect(
        fixture.collector.messages.filter((message) => method(message, "turn/started")),
      ).toHaveLength(started);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps rejecting an empty submission that is not a resume", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [] },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 2)),
      ).resolves.toMatchObject({
        error: { code: -32602, message: "External input must be a non-empty array" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
