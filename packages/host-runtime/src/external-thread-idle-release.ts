import {
  DEFAULT_IDLE_RELEASE_SETTINGS,
  idleReleaseSettingsSchema,
  type IdleReleaseSettings,
} from "@codexhost/shared-contracts";
import type { ExternalThread } from "./external-thread-runtime.js";
import type { DesktopRequestQueue } from "./desktop-request-queue.js";

const CHECK_INTERVAL_MS = 60_000;
const CLOSE_TIMEOUT_MS = 60_000;
const CLOSE_FAILURE =
  "External Session resource release failed. Further use is blocked to avoid duplicate writers. Restart Codex Desktop to retry recovery; residual processes may require manual cleanup.";

interface Activity {
  lastActivity: number;
  outputFailed: boolean;
  closeFailed: boolean;
}

/** Host-only coordination. This deliberately makes no claim about native background work. */
export class ExternalThreadIdleRelease {
  readonly #activity = new WeakMap<ExternalThread, Activity>();
  readonly #operations = new Map<string, number>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #scheduled = new Set<string>();
  #settings: IdleReleaseSettings = { ...DEFAULT_IDLE_RELEASE_SETTINGS };
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(
    private readonly options: {
      threads(): ExternalThread[];
      get(id: string): ExternalThread | undefined;
      remove(id: string): void;
      canRelease(thread: ExternalThread): boolean;
      onClosed?(thread: ExternalThread): Promise<void>;
      queue: DesktopRequestQueue;
      diagnose(error: unknown): void;
    },
  ) {}

  configure(value: unknown): IdleReleaseSettings {
    const settings = idleReleaseSettingsSchema.parse(value);
    if (this.#stopped) throw new Error("Host is shutting down");
    this.#settings = settings;
    if (settings.enabled && !this.#timer) {
      this.#timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
      this.#timer.unref();
    } else if (!settings.enabled && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    return { ...settings };
  }

  touch(thread: ExternalThread): void {
    const state = this.#activity.get(thread);
    if (state) state.lastActivity = Date.now();
    else
      this.#activity.set(thread, {
        lastActivity: Date.now(),
        outputFailed: false,
        closeFailed: false,
      });
  }

  outputFailed(thread: ExternalThread): void {
    this.touch(thread);
    const state = this.#activity.get(thread);
    if (state) state.outputFailed = true;
  }

  failure(thread: ExternalThread): string | undefined {
    return this.#activity.get(thread)?.closeFailed ? CLOSE_FAILURE : undefined;
  }

  async waitForClose(id: string): Promise<void> {
    await this.#closing.get(id);
  }

  /** Acquire before resolving a Session, not after an await has exposed its reference. */
  async runOperation<T>(id: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (this.#stopped) throw new Error("Host is shutting down");
    if (id) {
      while (this.#closing.has(id)) await this.#closing.get(id);
    }
    if (this.#stopped) throw new Error("Host is shutting down");
    return this.#track(id, operation);
  }

  /** Closing may emit outputs: consume them without waiting on the close being drained. */
  consumeOutput<T>(thread: ExternalThread, operation: () => Promise<T>): Promise<T> {
    this.touch(thread);
    return this.#track(thread.id, operation, false);
  }

  #track<T>(id: string | undefined, operation: () => Promise<T>, drain = true): Promise<T> {
    if (id) this.#operations.set(id, (this.#operations.get(id) ?? 0) + 1);
    const task = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (id) {
          const remaining = (this.#operations.get(id) ?? 1) - 1;
          if (remaining) this.#operations.set(id, remaining);
          else {
            this.#operations.delete(id);
            const thread = this.options.get(id);
            if (thread) this.touch(thread);
          }
        }
        this.#pending.delete(task);
      });
    if (drain) this.#pending.add(task);
    return task;
  }

  #eligible(thread: ExternalThread): boolean {
    const state = this.#activity.get(thread);
    return (
      !this.#stopped &&
      this.#settings.enabled &&
      !!state &&
      !state.outputFailed &&
      !state.closeFailed &&
      this.options.get(thread.id) === thread &&
      !this.#closing.has(thread.id) &&
      !this.#operations.has(thread.id) &&
      !thread.record.subagent &&
      thread.record.state === "ready" &&
      !!thread.record.nativeSessionRef &&
      !thread.persistenceError &&
      !thread.running &&
      !thread.activeTurnId &&
      this.options.canRelease(thread) &&
      Date.now() - state.lastActivity >= this.#settings.timeoutMinutes * 60_000
    );
  }

  check(): void {
    for (const thread of this.options.threads()) {
      if (this.#scheduled.has(thread.id) || !this.#eligible(thread)) continue;
      this.#scheduled.add(thread.id);
      const task = this.options.queue
        .run(thread.id, async () => {
          // Requests and settings may have changed while this candidate was queued.
          if (!this.#eligible(thread)) return;
          const closing = this.#close(thread);
          this.#closing.set(thread.id, closing);
          try {
            await closing;
          } finally {
            this.#closing.delete(thread.id);
          }
        })
        .catch(this.options.diagnose)
        .finally(() => this.#scheduled.delete(thread.id));
      this.#pending.add(task);
      void task.finally(() => this.#pending.delete(task));
    }
  }

  async #close(thread: ExternalThread): Promise<void> {
    const state = this.#activity.get(thread);
    if (!state) return;
    let timeout: NodeJS.Timeout | undefined;
    // Only the bounded waiter may retire the instance. Late underlying completion cannot do so.
    const closed = Promise.resolve().then(async () => {
      await thread.session.close();
      await thread.outputTask;
      await this.options.onClosed?.(thread);
    });
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Session release timed out")),
            CLOSE_TIMEOUT_MS,
          );
          timeout.unref();
        }),
      ]);
      if (
        state.outputFailed ||
        thread.persistenceError ||
        thread.record.state !== "ready" ||
        !thread.record.nativeSessionRef
      ) {
        throw new Error("Session release could not confirm persisted history and identity");
      }
      if (this.options.get(thread.id) !== thread) throw new Error("Session changed during release");
      this.options.remove(thread.id);
    } catch (error) {
      state.closeFailed = true;
      this.options.diagnose(error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  disable(): void {
    this.#settings = { ...this.#settings, enabled: false };
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  stop(): void {
    this.#stopped = true;
    this.disable();
  }

  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
}
