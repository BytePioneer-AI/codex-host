import { afterEach, expect, it, vi, type Mock } from "vitest";
import {
  voiceFailure,
  voiceTranscribeResultSchema,
  type VoiceTranscribeResult,
} from "@codexhost/shared-contracts";
import type { InputActions } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { VoiceInput } from "../../apps/web-ui/packages/client/ui-codexhost/src/client/voice-input.ts";

class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported(type: string) {
    return type === "audio/mp4";
  }
  mimeType: string;
  state = "inactive";
  onstop?: () => void;
  ondataavailable?: (event: { data: Blob }) => void;
  onerror?: () => void;
  constructor(_stream: unknown, options?: { mimeType: string }) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    Recorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
    this.onstop?.();
  }
}
const controllers: VoiceInput[] = [];
afterEach(() => {
  controllers.splice(0).forEach((voice) => voice.discard());
  Recorder.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
type Transcribe = (audio: Blob, signal: AbortSignal) => Promise<VoiceTranscribeResult>;
function setup(
  transcribe: Mock<Transcribe> = vi.fn<Transcribe>(async () => ({ ok: true, text: "你好" })),
) {
  const stop = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) },
  });
  vi.stubGlobal("MediaRecorder", Recorder);
  const actions = {
    captureInsertion: vi.fn(() => ({ start: 2, end: 2, draftRev: 3 })),
    insertText: vi.fn(() => true),
    submit: vi.fn(),
  } as unknown as InputActions;
  const voice = new VoiceInput(transcribe);
  controllers.push(voice);
  const unbind = voice.bind(actions, false);
  return { voice, actions, stop, transcribe, unbind };
}

it("captures at recording start, uploads the actual MIME and inserts without submitting", async () => {
  const { voice, actions, transcribe, stop } = setup();
  await voice.start();
  expect(actions.captureInsertion).toHaveBeenCalledOnce();
  expect(voice.getSnapshot().phase).toBe("recording");
  voice.stop();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("idle"));
  expect(transcribe.mock.calls[0]?.[0]).toMatchObject({ type: "audio/mp4" });
  expect(actions.insertText).toHaveBeenCalledWith("你好", { start: 2, end: 2, draftRev: 3 });
  expect(stop).toHaveBeenCalled();
});

it("send submits once after inserting the transcript, and never when insertion fails", async () => {
  const { voice, actions } = setup();
  await voice.start();
  voice.send();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("idle"));
  expect(actions.insertText).toHaveBeenCalledOnce();
  expect(actions.submit).toHaveBeenCalledOnce();
  expect(vi.mocked(actions.insertText).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(actions.submit).mock.invocationCallOrder[0]!,
  );

  vi.mocked(actions.insertText).mockReturnValue(false);
  await voice.start();
  voice.send();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("text"));
  expect(actions.submit).toHaveBeenCalledOnce();
  voice.discard();

  vi.mocked(actions.insertText).mockReturnValue(true);
  await voice.start();
  voice.stop();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("idle"));
  expect(actions.submit).toHaveBeenCalledOnce();
});

it("retains text across a conversation switch and only inserts on explicit action", async () => {
  let finish!: (value: { ok: true; text: string }) => void;
  const { voice, actions, unbind } = setup(
    vi.fn<Transcribe>(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    ),
  );
  await voice.start();
  voice.stop();
  unbind();
  const next = {
    captureInsertion: vi.fn(() => ({ draftRev: 4 })),
    insertText: vi.fn(() => true),
  } as unknown as InputActions;
  voice.bind(next, false);
  finish({ ok: true, text: "保留文字" });
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("text"));
  expect(actions.insertText).not.toHaveBeenCalled();
  expect(next.insertText).not.toHaveBeenCalled();
  voice.insert();
  expect(next.insertText).toHaveBeenCalledWith("保留文字", { draftRev: 4 });
});

it.each(["edited", "locked"])("preserves text instead of overwriting a %s draft", async (kind) => {
  const { voice, actions } = setup();
  await voice.start();
  if (kind === "edited") vi.mocked(actions.insertText).mockReturnValue(false);
  else voice.bind(actions, true);
  voice.stop();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("text"));
  expect(voice.getSnapshot().text).toBe("你好");
});

it.each(["timeout", "host-incompatible"] as const)(
  "shows %s with retained audio for explicit retry, never retries automatically",
  async (code) => {
    const failure = voiceFailure(code);
    const transcribe = vi
      .fn<Transcribe>()
      .mockResolvedValueOnce(voiceTranscribeResultSchema.parse(failure))
      .mockResolvedValueOnce({ ok: true, text: "重试成功" });
    const { voice } = setup(transcribe);
    await voice.start();
    voice.stop();
    await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("failed"));
    expect(voice.getSnapshot().error).toBe(code);
    expect(transcribe).toHaveBeenCalledOnce();
    await voice.retry();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[0]?.[0]).toBe(transcribe.mock.calls[1]?.[0]);
  },
);

it("cancel releases the microphone without uploading; five minutes automatically stops", async () => {
  vi.useFakeTimers();
  const { voice, stop, transcribe } = setup();
  await voice.start();
  voice.discard();
  expect(stop).toHaveBeenCalled();
  expect(transcribe).not.toHaveBeenCalled();
  await voice.start();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(transcribe).toHaveBeenCalledOnce();
});

it("reports browser recording limitations on HTTP without hiding the entry; denied permissions are clear", async () => {
  const { voice } = setup();
  vi.stubGlobal("navigator", {});
  await voice.start();
  expect(voice.getSnapshot().error).toBe("browser-unsupported");
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        throw { name: "NotAllowedError" };
      },
    },
  });
  await voice.start();
  expect(voice.getSnapshot().error).toBe("permission-denied");
});

it("cancel while permission is pending releases a late stream", async () => {
  const { voice, transcribe } = setup();
  const stop = vi.fn();
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  });
  const starting = voice.start();
  voice.discard();
  resolve({ getTracks: () => [{ stop }] });
  await starting;
  expect(stop).toHaveBeenCalledOnce();
  expect(transcribe).not.toHaveBeenCalled();
});

it("a short cancel discards at once; a long one can be undone, then expires", async () => {
  vi.useFakeTimers();
  const { voice, actions, transcribe } = setup();
  await voice.start();
  await vi.advanceTimersByTimeAsync(3_000);
  voice.cancel();
  expect(voice.getSnapshot().phase).toBe("idle");
  expect(transcribe).not.toHaveBeenCalled();

  await voice.start();
  await vi.advanceTimersByTimeAsync(16_000);
  voice.cancel();
  expect(voice.getSnapshot()).toMatchObject({ phase: "cancelled", seconds: 16 });
  expect(transcribe).not.toHaveBeenCalled();
  voice.undo();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("idle"));
  expect(transcribe).toHaveBeenCalledOnce();
  expect(actions.insertText).toHaveBeenCalledOnce();
  expect(actions.submit).not.toHaveBeenCalled();

  await voice.start();
  await vi.advanceTimersByTimeAsync(16_000);
  voice.cancel();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(voice.getSnapshot().phase).toBe("idle");
  expect(transcribe).toHaveBeenCalledOnce();
});

it("the shortcut toggle starts only when available and finishes into the draft; rerecord starts over", async () => {
  const { voice, actions, transcribe } = setup();
  voice.bind(actions, false, false);
  voice.toggle();
  expect(voice.getSnapshot().phase).toBe("idle");
  voice.bind(actions, false, true);
  voice.toggle();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("recording"));
  voice.toggle();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("idle"));
  expect(actions.insertText).toHaveBeenCalledOnce();
  expect(actions.submit).not.toHaveBeenCalled();

  transcribe.mockResolvedValueOnce(voiceFailure("audio-empty"));
  await voice.start();
  voice.stop();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("failed"));
  voice.rerecord();
  await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe("recording"));
  expect(voice.getSnapshot().error).toBeUndefined();
});
