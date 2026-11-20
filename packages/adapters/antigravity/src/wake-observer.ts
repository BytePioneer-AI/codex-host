import type { HostTurnSnapshot } from "@codexhost/harness-adapter";
import { projectReplayedEventsToTurns } from "./acp-projection.js";
import { readNativeHistory } from "./native-replay.js";

const COMMIT_POLL_MS = 100;
const COMMIT_WAIT_MS = 10_000;

/** Idle ACP updates have no response/stop boundary or native Turn identity.
 * Publish the committed SQLite Turn, not a second, timer-segmented transcript. */
export class AntigravityWakeObserver {
  #cursor: number;
  #deadline = 0;
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
      publish(snapshot: HostTurnSnapshot): void;
    },
  ) {
    this.#cursor = options.cursor;
  }

  get observing(): boolean {
    return this.#work !== undefined || this.#timer !== undefined;
  }

  observe(): void {
    if (this.#closed) return;
    this.#deadline = Date.now() + COMMIT_WAIT_MS;
    if (!this.observing) void this.#startRead();
  }

  /** Probe once before submitting a successor, without waiting on a pending native wake. */
  async flush(): Promise<void> {
    if (this.#closed || !this.observing) return;
    if (this.#work) return this.#work;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#startRead();
  }

  #startRead(): Promise<void> {
    return (this.#work = this.#read().finally(() => {
      this.#work = undefined;
    }));
  }

  async #read(): Promise<void> {
    let retry = true;
    try {
      const { nativeSessionId, home, cwd, outputLimit } = this.options;
      const { events, pendingWake } = await readNativeHistory(nativeSessionId, home);
      if (this.#closed || !this.options.canPublish()) return;
      const firstNew = events.findIndex(
        (event) => event.type === "history.autonomous" && event.stepIndex > this.#cursor,
      );
      if (firstNew < 0) return;
      const turns = projectReplayedEventsToTurns({
        nativeSessionId,
        cwd,
        events,
        ...(outputLimit !== undefined ? { outputLimit } : {}),
      });
      for (const turn of turns) {
        const key = turn.nativeTurnRef.nativeTurnKey;
        if (!key.startsWith("wake-")) continue;
        const idx = Number(key.slice(5));
        if (idx <= this.#cursor) continue;
        this.options.publish(turn);
        this.#cursor = idx;
      }
      retry = pendingWake;
    } catch {
      // Native writes may still be committing. A history read remains the
      // recovery path if the commit outlives the observation window.
    } finally {
      if (retry && !this.#closed && Date.now() < this.#deadline) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          void this.#startRead();
        }, COMMIT_POLL_MS);
        this.#timer.unref();
      }
    }
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
