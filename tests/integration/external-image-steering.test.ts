import type { HostCommand } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";

import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "../../packages/host-runtime/test/app-server-host-fixture.js";
import { installRendererExternalSteering } from "../../packages/renderer-extension/src/renderer-external-steering.js";
import { createRemoteAttachmentSender } from "../../packages/renderer-extension/src/renderer-remote-attachments.js";

const image = { type: "image", url: "data:image/png;base64,aGVsbG8=" };
const localImage = { type: "localImage", path: "/remote/image.png" };
function manifest(paths: string[], request = ""): string {
  return (
    "# Files mentioned by the user:\n" +
    paths.map((path) => `\n## image.png: ${path}\nImage attachment: true\n`).join("") +
    `\n## My request:\n${request}`
  );
}

/** Only Desktop presentation and the native file store are simulated; RPC reaches AppServerHost. */
async function fixture(nativeSteer = false) {
  const host = createFixture();
  host.adapter.supportsSteer = nativeSteer;
  const threadId = await startPiThread(host);
  const turnId = await startPiTurn(host, threadId);
  const session = host.adapter.sessions[0];
  if (!session) throw new Error("No Harness Session");
  session.completeCancellationOnRequest();
  const execute = vi.spyOn(session, "execute");
  let id = 100;
  const rpc = vi.fn(async (method: string, params: JsonObject): Promise<JsonObject> => {
    const request = ++id;
    writeRequest(host.desktopInput, { id: request, method, params });
    const response = await host.collector.waitFor((message) => requestId(message, request));
    if (response.error) {
      const error = response.error as JsonObject;
      throw Object.assign(new Error(String(error.message)), { code: error.code });
    }
    return response.result as JsonObject;
  });
  const queued = [{ id: "follow-up", pausedReason: "User paused", input: [localImage] }];
  const createFileAttachment = vi.fn(async () => {
    const path = `/remote/upload-${createFileAttachment.mock.calls.length}.png`;
    return { path, fsPath: path };
  });
  const manager = {
    sendRequest: rpc,
    getConversation: (id: string) => ({ id, modelProvider: "codexhost" }),
    createFileAttachment,
    getTurnCoordinator: () => ({
      options: {
        submissionHost: {
          getActiveTurnId: () => turnId,
          hasPendingTurnStart: () => false,
        },
      },
      loadMessages: async () => undefined,
      readMessages: () => queued,
      mutate: (_id: string, update: (messages: typeof queued) => typeof queued) => {
        queued.splice(0, queued.length, ...update(queued));
      },
    }),
    steerTurn: async (
      id: string,
      input: JsonObject[],
      _restore: unknown,
      _tier: unknown,
      _attachments: unknown,
      clientUserMessageId: string,
    ) =>
      manager.sendRequest("turn/steer", {
        threadId: id,
        expectedTurnId: turnId,
        input,
        clientUserMessageId,
      }),
    startTurn: vi.fn(async (_id: string, operation: { request: JsonObject; context: unknown }) =>
      manager.sendRequest("turn/start", operation.request),
    ),
  };
  const dispose = installRendererExternalSteering(
    manager,
    createRemoteAttachmentSender(manager, "ssh:remote", () => true),
  );
  if (!dispose) throw new Error("Renderer steering was not installed");
  return {
    host,
    session,
    execute,
    rpc,
    manager,
    threadId,
    turnId,
    queued,
    steer: (input: JsonObject[]) =>
      manager.steerTurn(
        threadId,
        input,
        { id: "image-message", context: {} },
        null,
        [{ path: localImage.path }],
        "image-message",
      ),
    close: async () => {
      dispose();
      await stopFixture(host);
    },
  };
}

describe("Renderer image submissions through the remote attachment sender and Host", () => {
  it("accepts surplus native references after remote fallback uploads all inline images", async () => {
    const f = await fixture();
    try {
      f.session.succeedTurn();
      await f.host.collector.waitFor((message) => turnEvent(message, "turn/completed", f.turnId));
      await expect(
        f.manager.sendRequest("turn/start", {
          threadId: f.threadId,
          input: [{ type: "text", text: manifest(["/remote/old.png"]) }, image, image],
        }),
      ).resolves.toHaveProperty("turn.id");
      expect(f.manager.createFileAttachment).toHaveBeenCalledTimes(2);
      const commands: HostCommand[] = f.execute.mock.calls.map(([command]) => command);
      const started = commands.find((command) => command.type === "turn.start");
      expect(started).toMatchObject({
        input: [{ type: "text", text: expect.stringContaining("/remote/old.png") }],
      });
      expect(JSON.stringify(started)).toContain("/remote/upload-1.png");
      expect(JSON.stringify(started)).toContain("/remote/upload-2.png");
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    "delivers an image-only queued input without losing its reference (native steer: %s)",
    async (native) => {
      const f = await fixture(native);
      try {
        const input = [localImage];
        const result = await f.steer(input);
        expect(result).toHaveProperty("turnId");
        expect(f.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            type: native ? "turn.steer" : "turn.start",
            input: [{ type: "text", text: expect.stringContaining(localImage.path) }],
          }),
        );
        const commands: HostCommand[] = f.execute.mock.calls.map(([command]) => command);
        expect(commands.filter((command) => command.type === "turn.cancel")).toHaveLength(
          native ? 0 : 1,
        );
        expect(f.manager.createFileAttachment).not.toHaveBeenCalled();
        expect(f.queued).toEqual([
          { id: "follow-up", pausedReason: "User paused", input: [localImage] },
        ]);
        if (native) {
          const projected = await f.host.collector.waitFor((message) => {
            if (message.method !== "item/completed") return false;
            const item = (message.params as JsonObject).item as JsonObject;
            return item.type === "userMessage" && item.clientId === "image-message";
          });
          expect(JSON.stringify(projected)).toContain(localImage.path);
          expect(result.turnId).toBe(f.turnId);
        } else {
          expect(result.turnId).not.toBe(f.turnId);
          expect(f.manager.startTurn).toHaveBeenCalledWith(
            f.threadId,
            expect.objectContaining({
              request: expect.objectContaining({ input, clientUserMessageId: "image-message" }),
              context: expect.objectContaining({ attachments: [{ path: localImage.path }] }),
            }),
            undefined,
          );
        }
      } finally {
        await f.close();
      }
    },
  );

  it.each([false, true])(
    "accepts an image-only native manifest with an inline preview (native steer: %s)",
    async (native) => {
      const f = await fixture(native);
      try {
        await expect(
          f.steer([{ type: "text", text: manifest([localImage.path]) }, image]),
        ).resolves.toHaveProperty("turnId");
        expect(f.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            type: native ? "turn.steer" : "turn.start",
            input: [{ type: "text", text: expect.stringContaining(localImage.path) }],
          }),
        );
        expect(f.manager.createFileAttachment).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it.each([false, true])(
    "rejects a serialized command with an image before cancelling or inserting (native steer: %s)",
    async (native) => {
      const f = await fixture(native);
      try {
        await expect(
          f.steer([{ type: "text", text: manifest([localImage.path], "/compact") }, localImage]),
        ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("separately") });
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.manager.createFileAttachment).not.toHaveBeenCalled();
        expect(f.queued).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );

  it("rejects a command after remote fallback adds native attachment context", async () => {
    const f = await fixture();
    try {
      f.session.succeedTurn();
      await f.host.collector.waitFor((message) => turnEvent(message, "turn/completed", f.turnId));
      await expect(
        f.manager.sendRequest("turn/start", {
          threadId: f.threadId,
          input: [{ type: "text", text: "/compact" }, image],
        }),
      ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("separately") });
      expect(f.manager.createFileAttachment).toHaveBeenCalledOnce();
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    "does not cancel or drop a queued follow-up when an inline image has no saved path (native: %s)",
    async (native) => {
      const f = await fixture(native);
      try {
        await expect(f.steer([image])).rejects.toMatchObject({ code: -32602 });
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.manager.createFileAttachment).not.toHaveBeenCalled();
        expect(f.queued).toEqual([
          { id: "follow-up", pausedReason: "User paused", input: [localImage] },
        ]);
      } finally {
        await f.close();
      }
    },
  );
});
