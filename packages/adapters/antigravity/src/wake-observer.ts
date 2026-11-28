import type { HostTurnSnapshot } from "@codexhost/harness-adapter";
import { projectReplayedEventsToTurns } from "./acp-projection.js";
import { readNativeDbFingerprint } from "./native-db-fingerprint.js";
import { readNativeHistory } from "./native-replay.js";
import { nativeConversationDbPath } from "./native-turn-boundaries.js";

export const WAKE_COMMIT_POLL_DELAYS_MS = [150, 250, 400, 600, 1000] as const;
const COMMIT_WAIT_MS = 10_000;

/** Idle ACP updates have no response/stop boundary or native Turn identity.
 * Publish the committed SQLite Turn, not a second, timer-segmented transcript. */
export class AntigravityWakeObserver {
  readonly #dbPath: string;
  readonly #readHistory: typeof readNativeHistory;
  readonly #pollDelaysMs: readonly number[];
  #cursor: number;
  #deadline = 0;
  #pollAttempt = 0;
  #timerDelayMs = 0;
  #lastFingerprint: string | null = null;
  #work: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(
    private readonly options: {
      nativeSessionId: string;
      cwd: string;
      home: string;
      cursor: number;
      outputLimit: number | undefined;
      canPublish(): boolean;
      /** Whether output that started at this native time was streamed into a live prompt's Turn. */
      streamedIntoPrompt(startedAtMs: number | undefined): boolean;
      publish(snapshot: HostTurnSnapshot): void;
      readHistory?: typeof readNativeHistory;
      pollDelaysMs?: readonly number[];
    },
  ) {
    this.#cursor = options.cursor;
    this.#dbPath = nativeConversationDbPath(options.nativeSessionId, options.home);
    this.#readHistory = options.readHistory ?? readNativeHistory;
    this.#pollDelaysMs =
      options.pollDelaysMs && options.pollDelaysMs.length > 0
        ? options.pollDelaysMs
        : WAKE_COMMIT_POLL_DELAYS_MS;
  }

  get observing(): boolean {
    return this.#work !== undefined || this.#timer !== undefined;
  }

  observe(): void {
    if (this.#closed) return;
    this.#deadline = Date.now() + COMMIT_WAIT_MS;
    this.#pollAttempt = 0;
    const firstDelay = this.#pollDelaysMs[0] ?? WAKE_COMMIT_POLL_DELAYS_MS[0];
    if (!this.observing) {
      void this.#startRead(false);
    } else if (this.#timer && this.#timerDelayMs > firstDelay) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#timerDelayMs = 0;
      this.#scheduleNextPoll();
    }
  }

  /** Probe once before submitting a successor, without waiting on a pending native wake. */
  async flush(): Promise<void> {
    if (this.#closed || !this.observing) return;
    if (this.#work) return this.#work;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerDelayMs = 0;
    return this.#startRead(true);
  }

  #startRead(force: boolean): Promise<void> {
    return (this.#work = this.#read(force).finally(() => {
      this.#work = undefined;
    }));
  }

  #scheduleNextPoll(): void {
    if (this.#closed || Date.now() >= this.#deadline) return;
    const index = Math.min(this.#pollAttempt, this.#pollDelaysMs.length - 1);
    const delay =
      this.#pollDelaysMs[index] ??
      this.#pollDelaysMs[this.#pollDelaysMs.length - 1] ??
      WAKE_COMMIT_POLL_DELAYS_MS[0];
    this.#pollAttempt += 1;
    this.#timerDelayMs = delay;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#timerDelayMs = 0;
      void this.#startRead(false);
    }, delay);
    this.#timer.unref();
  }

  async #read(force: boolean): Promise<void> {
    try {
      const fingerprint = await readNativeDbFingerprint(this.#dbPath);
      if (this.#closed) return;
      if (!force && fingerprint !== null && fingerprint === this.#lastFingerprint) {
        return;
      }
      if (fingerprint !== this.#lastFingerprint) {
        this.#pollAttempt = 0;
      }
      const { nativeSessionId, home, cwd, outputLimit } = this.options;
      const { events, wakeWatermark } = await this.#readHistory(nativeSessionId, home);
      if (this.#closed || !this.options.canPublish()) return;
      if (fingerprint !== null) this.#lastFingerprint = fingerprint;
      if (wakeWatermark <= this.#cursor) return;
      const turns = projectReplayedEventsToTurns({
        nativeSessionId,
        cwd,
        events,
        ...(outputLimit !== undefined ? { outputLimit } : {}),
      });
      const startedAt = new Map(
        events.flatMap((event) =>
          event.type === "history.autonomous"
            ? [[event.stepIndex, event.createdAtMs] as const]
            : [],
        ),
      );
      for (const turn of turns) {
        const key = turn.nativeTurnRef.nativeTurnKey;
        if (!key.startsWith("wake-")) continue;
        const idx = Number(key.slice(5));
        if (idx <= this.#cursor) continue;
        // A wake that ran inside a live prompt is already part of that user Turn.
        if (!this.options.streamedIntoPrompt(startedAt.get(idx))) this.options.publish(turn);
        this.#cursor = idx;
      }
    } catch {
      // A history read remains the recovery path if the commit outlives this window.
    } finally {
      // A notification carries no run ID. Finding a committed wake does not prove the
      // notified wake is already in SQLite; keep polling until the deadline.
      this.#scheduleNextPoll();
    }
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerDelayMs = 0;
  }
}
