import { describe, expect, it, vi } from "vitest";
import { ExternalVoice } from "../src/external-voice.js";
import type { ExternalVoiceCall } from "../src/external-voice-gateway.js";

const params = { outputModality: "audio", transport: { type: "webrtc", sdp: "v=0\r\noffer" } };

describe("voice lifecycle", () => {
  it.each(["thread/realtime/started", "thread/realtime/sdp"])(
    "does not resume startup after hangup while publishing %s",
    async (blockedMethod) => {
      const published = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const connect = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const notify = vi.fn<ExternalVoice["options"]["notify"]>(async (method) => {
        if (method === blockedMethod) {
          published.resolve(undefined);
          await release.promise;
        }
      });
      const voice = new ExternalVoice({
        createCall: async () => ({ sdp: "answer", connect, close, send: () => {} }),
        notify,
        runTask: vi.fn(),
        diagnose: vi.fn(),
      });
      const starting = voice.start("external", params);
      const rejectedStart = expect(starting).rejects.toThrow("could not start");
      await published.promise;
      await voice.stop("external");
      const notificationsAtHangup = notify.mock.calls.length;
      release.resolve(undefined);
      await rejectedStart;
      expect(connect).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(notificationsAtHangup);
      expect(notify.mock.calls.at(-1)?.[0]).toBe("thread/realtime/closed");
      expect(voice.has("external")).toBe(false);
    },
  );

  it("waits for cleanup when stopped during call creation and never publishes a late start", async () => {
    const creation = Promise.withResolvers<ExternalVoiceCall>();
    const close = vi.fn(async () => {});
    const notify = vi.fn<ExternalVoice["options"]["notify"]>(async () => {});
    const voice = new ExternalVoice({
      createCall: () => creation.promise,
      notify,
      runTask: vi.fn(),
      diagnose: vi.fn(),
    });
    const starting = voice.start("external", params);
    const rejectedStart = expect(starting).rejects.toThrow("could not start");
    const stopping = voice.stop("external");
    expect(voice.has("external")).toBe(true);
    creation.resolve({ sdp: "answer", close, connect: async () => {}, send: () => {} });
    await stopping;
    await rejectedStart;
    expect(close).toHaveBeenCalled();
    expect(notify.mock.calls.map((call) => call[0])).toEqual(["thread/realtime/closed"]);
    expect(voice.has("external")).toBe(false);
  });

  it("suppresses a late agent answer after hangup without cancelling its work", async () => {
    const answer = Promise.withResolvers<string>();
    let event: Parameters<
      ConstructorParameters<typeof ExternalVoice>[0]["createCall"]
    >[0]["onEvent"] = () => {};
    const send = vi.fn();
    const close = vi.fn(async () => {});
    const task = vi.fn(() => answer.promise);
    const voice = new ExternalVoice({
      createCall: async (input) => {
        event = input.onEvent;
        return { sdp: "answer", connect: async () => {}, send, close };
      },
      runTask: task,
      notify: async () => {},
      diagnose: vi.fn(),
    });
    await voice.start("external", params);
    event({
      type: "delegation.created",
      item: {
        id: "task",
        type: "delegation",
        target: "client",
        content: [{ type: "input_text", text: "request" }],
      },
    });
    expect(task).toHaveBeenCalledTimes(1);
    await voice.stop("external");
    answer.resolve("old result");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
