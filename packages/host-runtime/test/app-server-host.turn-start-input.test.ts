import { describe, expect, it } from "vitest";

import {
  createFixture,
  requestId,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("external turn/start text input", () => {
  it("accepts Desktop input_text items as the Turn prompt", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "input_text", text: "queued follow-up" }] },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 2));
      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({ turn: { status: "inProgress" } });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects a turn/start whose input array has no text", async () => {
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
        error: { code: -32602, message: "turn/start must contain text input" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
