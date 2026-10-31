import type { InputActions } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { VoiceErrorCode, VoiceTranscribeResult } from "@codexhost/shared-contracts";

/** Service codes plus browser-side recording failures; the view localizes them. */
export type VoiceInputError =
  VoiceErrorCode | "browser-unsupported" | "permission-denied" | "no-microphone" | "record-failed";

/** Number of recent input levels kept for the recording waveform. */
export const VOICE_LEVEL_BARS = 24;

/** Seconds of recording after which a cancel can be undone instead of discarding at once. */
export const VOICE_UNDO_AFTER_SECONDS = 15;
const UNDO_WINDOW_MS = 5000;
const SILENCE_MS = 3000;
const SLOW_TRANSCRIPTION_MS = 10_000;

export interface VoiceInputState {
  phase: "idle" | "permission" | "recording" | "transcribing" | "failed" | "text" | "cancelled";
  seconds: number;
  /** Recent microphone levels in 0..1, oldest first; display only. */
  levels?: readonly number[];
  /** Recording has heard nothing for a while: the microphone may be wrong. */
  silent?: boolean;
  /** Transcription is taking unusually long. */
  slow?: boolean;
  error?: VoiceInputError;
  text?: string;
}

/** Page-owned recording/result, retained when a conversation's slot unmounts. */
export class VoiceInput {
  private state: VoiceInputState = { phase: "idle", seconds: 0 };
  private listeners = new Set<() => void>();
  private binding?: { actions: InputActions; locked: boolean; available: boolean };
  private insertion?: {
    binding: NonNullable<VoiceInput["binding"]>;
    span: ReturnType<InputActions["captureInsertion"]>;
  };
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private timer?: ReturnType<typeof setInterval>;
  private meter?: { context: AudioContext; interval: ReturnType<typeof setInterval> };
  private audio?: Blob;
  private abort?: AbortController;
  private generation = 0;
  /** Set by {@link send}: submit once the transcript lands at the captured position. */
  private sendAfter = false;
  /** Set by {@link cancel} on a long recording: keep the audio for an undo window. */
  private cancelling = false;
  private undoTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly transcribe: (
      audio: Blob,
      signal: AbortSignal,
    ) => Promise<VoiceTranscribeResult>,
  ) {}

  getSnapshot = (): VoiceInputState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(state: VoiceInputState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  bind(actions: InputActions, locked: boolean, available = true): () => void {
    const binding = { actions, locked, available };
    this.binding = binding;
    return () => {
      if (this.binding === binding) this.binding = undefined;
    };
  }
  private releaseMic(): void {
    clearInterval(this.timer);
    if (this.meter) {
      clearInterval(this.meter.interval);
      void this.meter.context.close().catch(() => {});
      this.meter = undefined;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }

  async start(): Promise<void> {
    if (!this.binding || this.binding.locked || this.state.phase !== "idle") return;
    const binding = this.binding;
    this.insertion = { binding, span: binding.actions.captureInsertion() };
    this.sendAfter = false;
    const generation = ++this.generation;
    this.update({ phase: "permission", seconds: 0 });
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      this.update({
        phase: "idle",
        seconds: 0,
        error: "browser-unsupported",
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (generation === this.generation) chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (generation !== this.generation) return;
        this.discard();
        this.update({ phase: "idle", seconds: 0, error: "record-failed" });
      };
      recorder.onstop = () => {
        if (generation !== this.generation) return;
        this.releaseMic();
        this.audio = new Blob(chunks, {
          type: recorder.mimeType || chunks[0]?.type || mimeType || "audio/webm",
        });
        if (!this.cancelling) {
          void this.retry();
          return;
        }
        this.update({ phase: "cancelled", seconds: this.state.seconds });
        this.undoTimer = setTimeout(() => {
          if (generation === this.generation && this.state.phase === "cancelled") this.discard();
        }, UNDO_WINDOW_MS);
      };
      recorder.start();
      const started = Date.now();
      this.update({ phase: "recording", seconds: 0 });
      this.startMeter(stream, generation);
      this.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        this.update({ ...this.state, phase: "recording", seconds });
        if (seconds >= 300) this.stop();
      }, 1000);
    } catch (error) {
      if (generation !== this.generation) return;
      this.releaseMic();
      const name = (error as { name?: string })?.name;
      this.update({
        phase: "idle",
        seconds: 0,
        error:
          name === "NotAllowedError"
            ? "permission-denied"
            : name === "NotFoundError"
              ? "no-microphone"
              : "record-failed",
      });
    }
  }

  /** Sample the stream's loudness for the waveform; recording works without it. */
  private startMeter(stream: MediaStream, generation: number): void {
    if (typeof AudioContext === "undefined") return;
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let heardAt = Date.now();
      const interval = setInterval(() => {
        if (generation !== this.generation || this.state.phase !== "recording") return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 5);
        if (level > 0.06) heardAt = Date.now();
        const levels = [...(this.state.levels ?? []), level].slice(-VOICE_LEVEL_BARS);
        this.update({ ...this.state, levels, silent: Date.now() - heardAt > SILENCE_MS });
      }, 80);
      this.meter = { context, interval };
    } catch {
      // Decorative only.
    }
  }

  stop(): void {
    if (this.recorder?.state !== "recording") return;
    clearInterval(this.timer);
    this.update({ phase: "transcribing", seconds: this.state.seconds });
    this.recorder.stop();
  }

  /** Start when idle, finish (insert into the draft) while recording. */
  toggle(): void {
    if (this.state.phase === "idle" && this.binding?.available) void this.start();
    else if (this.state.phase === "recording") this.stop();
  }

  /** Cancel recording or transcription; a long recording stays undoable for a moment. */
  cancel(): void {
    if (
      this.state.phase === "recording" &&
      this.state.seconds >= VOICE_UNDO_AFTER_SECONDS &&
      this.recorder?.state === "recording"
    ) {
      clearInterval(this.timer);
      this.cancelling = true;
      this.recorder.stop();
      return;
    }
    this.discard();
  }

  /** Restore a just-cancelled long recording and transcribe it into the draft. */
  undo(): void {
    if (this.state.phase !== "cancelled") return;
    clearTimeout(this.undoTimer);
    this.cancelling = false;
    void this.retry();
  }

  /** Drop the kept audio and record again. */
  rerecord(): void {
    this.discard();
    void this.start();
  }

  /** Stop, then submit after the transcript is inserted; a failed insertion never sends. */
  send(): void {
    if (this.recorder?.state !== "recording") return;
    this.sendAfter = true;
    this.stop();
  }

  async retry(): Promise<void> {
    if (!this.audio || this.abort) return;
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.update({ ...this.state, phase: "transcribing", error: undefined, slow: false });
    const slow = setTimeout(() => {
      if (this.abort === abort) this.update({ ...this.state, slow: true });
    }, SLOW_TRANSCRIPTION_MS);
    try {
      const result = await this.transcribe(this.audio, abort.signal);
      if (generation !== this.generation) return;
      if (!result.ok) {
        this.update({ ...this.state, phase: "failed", error: result.error.code, slow: false });
        return;
      }
      this.audio = undefined;
      const target = this.insertion;
      if (
        target &&
        this.binding === target.binding &&
        !this.binding.locked &&
        target.binding.actions.insertText(result.text, target.span)
      ) {
        if (this.sendAfter) target.binding.actions.submit();
        this.sendAfter = false;
        this.update({ phase: "idle", seconds: 0 });
      } else {
        this.update({ phase: "text", seconds: 0, text: result.text });
      }
    } catch {
      if (generation === this.generation)
        this.update({ ...this.state, phase: "failed", error: "network", slow: false });
    } finally {
      clearTimeout(slow);
      if (this.abort === abort) this.abort = undefined;
    }
  }

  insert(): void {
    if (!this.state.text || !this.binding || this.binding.locked) return;
    const { actions } = this.binding;
    if (actions.insertText(this.state.text, actions.captureInsertion())) this.discard();
  }
  discard = (): void => {
    this.generation++;
    clearTimeout(this.undoTimer);
    this.cancelling = false;
    this.abort?.abort();
    this.abort = undefined;
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.recorder = undefined;
    this.releaseMic();
    this.audio = undefined;
    this.insertion = undefined;
    this.sendAfter = false;
    this.update({ phase: "idle", seconds: 0 });
  };
}
