import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { HostCommand } from "@codexhost/harness-adapter";
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

  it("stores an inline annotation image for an external first Turn", async () => {
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
      const response = await fixture.collector.waitFor((message) => requestId(message, 40));
      expect(response).not.toHaveProperty("error");
      const commands: HostCommand[] = execute.mock.calls.map(([value]) => value);
      const command = commands.find((value) => value.type === "turn.start");
      if (!command || command.type !== "turn.start" || command.input[0]?.type !== "text") {
        throw new Error("Missing external Turn input");
      }
      const saved = /## [^\n]+: ([^\n]+)\nImage attachment: true/u.exec(command.input[0].text)?.[1];
      if (!saved) throw new Error("Missing saved image path");
      expect(await readFile(saved, "utf8")).toBe("hello");
      expect(command.input[0].text).toContain("Check this image");
    } finally {
      await stopFixture(fixture);
    }
  });

  it("preserves the same stored image when a queued annotation is steered", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const input = [
        { type: "text", text: "Check this annotation" },
        { type: "image", url: "data:image/png;base64,aGVsbG8=" },
      ];
      writeRequest(fixture.desktopInput, {
        id: 50,
        method: "thread/queue/add",
        params: { threadId, clientUserMessageId: "annotation", input },
      });
      const queued = await fixture.collector.waitFor((message) => requestId(message, 50));
      expect(queued).not.toHaveProperty("error");
      writeRequest(fixture.desktopInput, {
        id: 51,
        method: "turn/steer",
        params: { threadId, expectedTurnId: turnId, clientUserMessageId: "annotation", input },
      });
      const steered = await fixture.collector.waitFor((message) => requestId(message, 51));
      expect(steered).not.toHaveProperty("error");
      const sent = fixture.adapter.sessions[0]?.steers[0]?.input[0];
      if (!sent || sent.type !== "text") throw new Error("Missing steered input");
      const saved = /## [^\n]+: ([^\n]+)\nImage attachment: true/u.exec(sent.text)?.[1];
      if (!saved) throw new Error("Missing saved image path");
      expect(await readFile(saved, "utf8")).toBe("hello");
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects an unsupported inline URL without starting the Turn", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.spyOn(session, "execute");
      writeRequest(fixture.desktopInput, {
        id: 60,
        method: "turn/start",
        params: { threadId, input: [{ type: "image", url: "https://example.com/image.png" }] },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 60));
      expect(response).toMatchObject({ error: { code: -32602 } });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await stopFixture(fixture);
    }
  });
});
