import {
  DEFAULT_IDLE_RELEASE_SETTINGS,
  idleReleaseSettingsSchema,
  type IdleReleaseSettings,
  type LoadedSession,
} from "@codexhost/shared-contracts";
import type { ExternalThread } from "./external-thread-runtime.js";
import type { DesktopRequestQueue } from "./desktop-request-queue.js";

const CHECK_INTERVAL_MS = 60_000;
const CLOSE_TIMEOUT_MS = 60_000;
const CLOSE_FAILURE =
  "External Session shutdown could not be confirmed. Retry after shutdown completes. If the Session stays blocked, stop any residual Harness processes and restart the codexhost Host.";

interface Activity {
  lastActivity: number;
  outputFailed: boolean;
  closeFailed: boolean;
  closeConfirmed: boolean;
}

/** Host-only coordination. Native background work is judged by `canRelease` (via `HarnessSession.hasBackgroundWork`). */
export class ExternalThreadIdleRelease {
  readonly #activity = new WeakMap<ExternalThread, Activity>();
  readonly #operations = new Map<string, number>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #scheduled = new Set<string>();
  /** Nothing is released until the Host applies the saved or default preference. */
  #settings: IdleReleaseSettings = { ...DEFAULT_IDLE_RELEASE_SETTINGS, enabled: false };
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
        closeConfirmed: false,
      });
  }

  outputFailed(thread: ExternalThread): void {
    this.touch(thread);
    const state = this.#activity.get(thread);
    if (state) state.outputFailed = true;
  }

  /** After a successful Session revival, allow idle release again. */
  clearOutputFailed(thread: ExternalThread): void {
    const state = this.#activity.get(thread);
    if (state) {
      state.outputFailed = false;
      state.lastActivity = Date.now();
    } else {
      this.touch(thread);
    }
  }

  failure(thread: ExternalThread): string | undefined {
    return this.#activity.get(thread)?.closeFailed ? CLOSE_FAILURE : undefined;
  }

  /** Called from the Thread's serialized lifecycle after waiting for the bounded close. */
  retireConfirmedRelease(thread: ExternalThread): boolean {
    const state = this.#activity.get(thread);
    if (
      !state?.closeFailed ||
      !state.closeConfirmed ||
      !this.#hasPersistedIdentity(thread, state) ||
      this.options.get(thread.id) !== thread
    ) {
      return false;
    }
    this.options.remove(thread.id);
    return true;
  }

  #hasPersistedIdentity(thread: ExternalThread, state: Activity): boolean {
    return (
      !state.outputFailed &&
      !thread.persistenceError &&
      thread.record.state === "ready" &&
      !!thread.record.nativeSessionRef
    );
  }

  async waitForClose(id: string): Promise<void> {
    await this.#closing.get(id);
  }

  /** Acquire before resolving a Session, not after an await has exposed its reference. */
  async runOperation<T>(
    id: string | undefined,
    operation: () => Promise<T>,
    options?: { touch?: boolean },
  ): Promise<T> {
    if (this.#stopped) throw new Error("Host is shutting down");
    if (id) {
      while (this.#closing.has(id)) await this.#closing.get(id);
    }
    if (this.#stopped) throw new Error("Host is shutting down");
    return this.#track(id, operation, true, options?.touch ?? true);
  }

  /** Closing may emit outputs: consume them without waiting on the close being drained. */
  consumeOutput<T>(
    thread: ExternalThread,
    operation: () => Promise<T>,
    options?: { touch?: boolean },
  ): Promise<T> {
    const touch = options?.touch ?? true;
    if (touch) this.touch(thread);
    return this.#track(thread.id, operation, false, touch);
  }

  #track<T>(
    id: string | undefined,
    operation: () => Promise<T>,
    drain = true,
    touch = true,
  ): Promise<T> {
    if (id) this.#operations.set(id, (this.#operations.get(id) ?? 0) + 1);
    const task = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (id) {
          if (touch) {
            const thread = this.options.get(id);
            if (thread) this.touch(thread);
          }
          const remaining = (this.#operations.get(id) ?? 1) - 1;
          if (remaining) this.#operations.set(id, remaining);
          else this.#operations.delete(id);
        }
        this.#pending.delete(task);
      });
    if (drain) this.#pending.add(task);
    return task;
  }

  /** Read only: never resolve a Session or touch its activity clock. */
  list(): LoadedSession[] {
    const now = Date.now();
    return this.options.threads().map((thread) => {
      const activity = this.#activity.get(thread);
      const inactiveMs = Math.max(0, now - (activity?.lastActivity ?? now));
      let state: LoadedSession["state"] = "idle";
      let reason: LoadedSession["reason"] = "none";
      if (activity?.closeFailed) {
        state = "failed";
        reason = "closeFailed";
      } else if (this.#closing.has(thread.id)) {
        state = "closing";
      } else if (thread.running || thread.activeTurnId) {
        state = "running";
        reason = "operation";
      } else if (thread.persistenceError || activity?.outputFailed) {
        state = "blocked";
        reason = "persistence";
      } else if (
        thread.record.subagent ||
        thread.record.state !== "ready" ||
        !thread.record.nativeSessionRef
      ) {
        state = "blocked";
        reason = "identity";
      } else if (this.#operations.has(thread.id)) {
        state = "busy";
        reason = "operation";
      } else if (!this.options.canRelease(thread)) {
        state = "busy";
        reason = "background";
      } else if (!this.#settings.enabled) {
        reason = "disabled";
      } else if (inactiveMs < this.#settings.timeoutMinutes * 60_000) {
        reason = "timeout";
      }
      return {
        threadId: thread.id,
        title: thread.record.title ?? thread.id,
        harnessId: thread.harnessId,
        state,
        reason,
        inactiveMs,
      };
    });
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
    // Late completion records proof without changing which instance owns the Thread.
    const closed = Promise.resolve().then(async () => {
      await thread.session.close();
      await thread.outputTask;
      await this.options.onClosed?.(thread);
      state.closeConfirmed = true;
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
      if (!this.#hasPersistedIdentity(thread, state)) {
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
