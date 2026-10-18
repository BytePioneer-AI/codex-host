import { describe, expect, it, vi } from "vitest";
import { ExternalVoice } from "../src/external-voice.js";
import type { ExternalVoiceCall } from "../src/external-voice-gateway.js";

const params = { outputModality: "audio", transport: { type: "webrtc", sdp: "v=0\r\noffer" } };

async function voiceSession() {
  let event: Parameters<
    ConstructorParameters<typeof ExternalVoice>[0]["createCall"]
  >[0]["onEvent"] = () => {};
  const send = vi.fn();
  const task = vi.fn();
  const voice = new ExternalVoice({
    createCall: async (input) => {
      event = input.onEvent;
      return { sdp: "answer", connect: async () => {}, send, close: async () => {} };
    },
    runTask: task,
    notify: async () => {},
    diagnose: vi.fn(),
  });
  await voice.start("external", params);
  return { event, send, task, voice };
}

describe("voice lifecycle", () => {
  it("answers a native handoff before turn.done and deduplicates its later transcript", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("Two empty folders.");
    session.event({
      type: "turn.created",
      turn: { id: "u-native", role: "user", transcript: "What" },
    });
    const handoff = {
      type: "delegation.created",
      item: {
        id: "native-handle",
        type: "delegation",
        target: "client",
        handoff_id: "handoff-native",
        user_bidi_turn_id: "u-native",
        content: [{ type: "input_text", text: "What files did you just find?" }],
      },
    };
    session.event(handoff);
    session.event(handoff);
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(1));
    expect(session.task).toHaveBeenCalledWith(
      "external",
      "What files did you just find?",
      expect.any(AbortSignal),
    );
    await vi.waitFor(() =>
      expect(session.send).toHaveBeenCalledWith({
        type: "delegation.context.append",
        delegation_item_id: "native-handle",
        channel: "speakable",
        content: [{ type: "input_text", text: "Two empty folders." }],
      }),
    );
    session.event({
      type: "turn.done",
      turn: { id: "u-native", role: "user", transcript: "What files did you just find?" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.task).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledTimes(1);
    await session.voice.close();
  });

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

  it("starts a Harness task from a user transcript when the speech model does not delegate", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("Only empty outputs/ and work/.");
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(1));
    expect(session.task).toHaveBeenCalledWith(
      "external",
      "你啱啱搵到咩檔案",
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());
    expect(session.send).toHaveBeenCalledWith({
      type: "session.context.append",
      content: [{ type: "input_text", text: "Only empty outputs/ and work/." }],
    });
  });

  it("starts a new Harness turn when the same question arrives on a distinct user turn", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("ok");
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(1));
    session.event({
      type: "turn.done",
      turn: { id: "u2", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(2));
  });

  it("starts distinct rapid user turns without waiting for a quiet window", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("ok");
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    session.event({
      type: "turn.done",
      turn: { id: "u2", role: "user", transcript: "你啱啱個任務搵到啲咩" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(2));
    expect(session.task).toHaveBeenNthCalledWith(
      1,
      "external",
      "你啱啱搵到咩檔案",
      expect.any(AbortSignal),
    );
    expect(session.task).toHaveBeenNthCalledWith(
      2,
      "external",
      "你啱啱個任務搵到啲咩",
      expect.any(AbortSignal),
    );
  });

  it("keeps one Harness turn and appends session context when a paraphrased delegation has no turn id", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("Only empty outputs/ and work/.");
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    session.event({
      type: "delegation.created",
      item: {
        id: "task",
        type: "delegation",
        target: "client",
        content: [{ type: "input_text", text: "Summarize the files found by the previous task." }],
      },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(1));
    expect(session.task).toHaveBeenCalledWith(
      "external",
      "你啱啱搵到咩檔案",
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());
    expect(session.send).toHaveBeenCalledWith({
      type: "session.context.append",
      content: [{ type: "input_text", text: "Only empty outputs/ and work/." }],
    });
    expect(session.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ delegation_item_id: "task" }),
    );
  });

  it("attaches a late delegation that names the user turn without a second Harness turn", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("Only empty outputs/ and work/.");
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());
    session.event({
      type: "delegation.created",
      item: {
        id: "late",
        type: "delegation",
        target: "client",
        turn_id: "u1",
        content: [{ type: "input_text", text: "Summarize the files found by the previous task." }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.task).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledWith({
      type: "delegation.context.append",
      delegation_item_id: "late",
      channel: "speakable",
      content: [{ type: "input_text", text: "Only empty outputs/ and work/." }],
    });
  });

  it("runs a linked handoff before the final transcript and deduplicates that transcript", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("Only empty outputs/ and work/.");
    session.event({
      type: "delegation.created",
      item: {
        id: "early",
        type: "delegation",
        target: "client",
        turn_id: "u1",
        content: [{ type: "input_text", text: "你啱啱搵到咩檔案" }],
      },
    });
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(1));
    expect(session.task).toHaveBeenCalledWith(
      "external",
      "你啱啱搵到咩檔案",
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());
    expect(session.send).toHaveBeenCalledWith({
      type: "delegation.context.append",
      delegation_item_id: "early",
      channel: "speakable",
      content: [{ type: "input_text", text: "Only empty outputs/ and work/." }],
    });
  });

  it("appends context for a no-id delegation path after one user transcript", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("Only empty outputs/ and work/.");
    session.event({
      type: "delegation.created",
      item: {
        id: "early-noid",
        type: "delegation",
        target: "client",
        content: [{ type: "input_text", text: "Summarize the files found by the previous task." }],
      },
    });
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());
    expect(session.send).toHaveBeenCalledWith({
      type: "session.context.append",
      content: [{ type: "input_text", text: "Only empty outputs/ and work/." }],
    });
    expect(session.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ delegation_item_id: "early-noid" }),
    );
  });

  it("does not run a late unlinked delegation after two user utterances", async () => {
    const session = await voiceSession();
    session.task.mockImplementation(async (_thread, text) => `answer:${text}`);
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    session.event({
      type: "turn.done",
      turn: { id: "u2", role: "user", transcript: "你啱啱個任務搵到啲咩" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(2));
    session.event({
      type: "delegation.created",
      item: {
        id: "late-unlinked",
        type: "delegation",
        target: "client",
        content: [{ type: "input_text", text: "Summarize the files found by the previous task." }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.task).toHaveBeenCalledTimes(2);
    expect(session.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ delegation_item_id: "late-unlinked" }),
    );
  });

  it("does not bind an unrelated delegation to an old completed unmatched turn", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("Only empty outputs/ and work/.");
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());
    session.event({
      type: "delegation.created",
      item: {
        id: "unrelated",
        type: "delegation",
        target: "client",
        content: [{ type: "input_text", text: "Start a new investigation." }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.task).toHaveBeenCalledTimes(1);
    expect(session.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ delegation_item_id: "unrelated" }),
    );
  });

  it("does not bind a late no-id handle to a later unrelated user transcript", async () => {
    const session = await voiceSession();
    session.task
      .mockResolvedValueOnce("Only empty outputs/ and work/.")
      .mockResolvedValueOnce("The passphrase is still blue moon.");
    session.event({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "你啱啱搵到咩檔案" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());
    session.event({
      type: "delegation.created",
      item: {
        id: "old-handle",
        type: "delegation",
        target: "client",
        content: [{ type: "input_text", text: "Summarize the files found by the previous task." }],
      },
    });
    session.event({
      type: "turn.done",
      turn: { id: "u2", role: "user", transcript: "藍色月亮係咩" },
    });
    await vi.waitFor(() => expect(session.task).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(session.send).toHaveBeenCalledWith({
        type: "session.context.append",
        content: [{ type: "input_text", text: "The passphrase is still blue moon." }],
      }),
    );
    expect(session.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        delegation_item_id: "old-handle",
        content: [{ type: "input_text", text: "The passphrase is still blue moon." }],
      }),
    );
  });

  it("passes resumed Thread messages into call creation", async () => {
    const createCall = vi.fn(async () => ({
      sdp: "answer",
      connect: async () => {},
      send: () => {},
      close: async () => {},
    }));
    const voice = new ExternalVoice({
      createCall,
      runTask: vi.fn(),
      notify: async () => {},
      diagnose: vi.fn(),
    });
    const conversation = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Only empty outputs/ and work/." }],
      },
    ];
    await voice.start("external", params, conversation);
    expect(createCall).toHaveBeenCalledWith(expect.objectContaining({ input: conversation }));
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
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: "request" },
    });
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1));
    await voice.stop("external");
    answer.resolve("old result");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not start Harness work from delegation when no user transcript arrives", async () => {
    const session = await voiceSession();
    session.task.mockResolvedValue("should not run");
    session.event({
      type: "delegation.created",
      item: {
        id: "task",
        type: "delegation",
        target: "client",
        content: [{ type: "input_text", text: "request" }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.task).not.toHaveBeenCalled();
    expect(session.send).not.toHaveBeenCalled();
  });
});
