import { describe, expect, it, vi } from "vitest";
import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const imagePath = "C:\\project\\截图 one.png";
const context = `# Files mentioned by the user:\n\n## 截图 one.png: ${imagePath}\nImage attachment: true\n\n## My request:\nCheck this image`;

describe("External Harness image input", () => {
  it("keeps a local image reference on turn/start when Desktop has no text manifest", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.spyOn(session, "execute");
      writeRequest(fixture.desktopInput, {
        id: 20,
        method: "turn/start",
        params: {
          threadId,
          input: [
            { type: "text", text: "Check this image" },
            { type: "localImage", path: imagePath },
          ],
        },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 20));
      expect(response).not.toHaveProperty("error");
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "turn.start",
          input: [{ type: "text", text: expect.stringContaining(imagePath) }],
        }),
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["localImage", "image"])(
    "accepts a Desktop %s preview with native attachment context during the active Turn",
    async (type) => {
      const fixture = createFixture();
      fixture.adapter.supportsSteer = true;
      try {
        const threadId = await startPiThread(fixture);
        const turnId = await startPiTurn(fixture, threadId);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Session was not opened");
        const execute = vi.spyOn(session, "execute");
        writeRequest(fixture.desktopInput, {
          id: 30,
          method: "turn/steer",
          params: {
            threadId,
            expectedTurnId: turnId,
            input: [
              { type: "text", text: context },
              type === "localImage"
                ? { type, path: imagePath }
                : { type, url: "data:image/png;base64,aGVsbG8=" },
            ],
          },
        });
        await expect(
          fixture.collector.waitFor((message) => requestId(message, 30)),
        ).resolves.toMatchObject({ result: { turnId, delivery: "activeTurn" } });
        expect(session.steers[0]?.input).toEqual([{ type: "text", text: context }]);
        expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn.cancel" }));
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("rejects an unstored inline image before starting a text-only Turn", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.spyOn(session, "execute");
      writeRequest(fixture.desktopInput, {
        id: 40,
        method: "turn/start",
        params: {
          threadId,
          input: [
            { type: "text", text: "Check this image" },
            { type: "image", url: "data:image/png;base64,aGVsbG8=" },
          ],
        },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 40)),
      ).resolves.toMatchObject({ error: { code: -32602 } });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await stopFixture(fixture);
    }
  });
});
