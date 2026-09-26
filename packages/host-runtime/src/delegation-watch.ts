import {
  DEFAULT_WATCH_TIMEOUT_MS,
  DelegationControlError,
  type DelegationControlApi,
  type DelegationThreadSnapshot,
  type ThreadWatchEntry,
  type ThreadWatchInput,
  type ThreadWatchListResult,
  type ThreadWatchOutcome,
  type ThreadWatchResult,
} from "./delegation-types.js";

export { DEFAULT_WATCH_TIMEOUT_MS };
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** How long a fired notification may wait for a busy or unreachable subscriber. */
const DELIVERY_WINDOW_MS = 6 * 60 * 60_000;
const MAX_UNDELIVERABLE_ENTRIES = 50;
/** Reads failing for this long are reported instead of waiting for the timeout. */
const UNREADABLE_GRACE_MS = 60_000;

interface Watch extends ThreadWatchEntry {
  timeoutMs: number;
  deadline: number;
  deliveryDeadline?: number;
  unreadableSince?: number;
  lastReadError?: string;
}

function terminal(status: DelegationThreadSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof DelegationControlError ? error.code : undefined;
}

function threadLink(threadId: string): string {
  return `codex://threads/${threadId}`;
}

function duration(milliseconds: number): string {
  return milliseconds < 60_000
    ? `${Math.round(milliseconds / 1_000)} s`
    : `${Math.round(milliseconds / 60_000)} min`;
}

function describe(watch: Watch): string {
  const link = threadLink(watch.threadId);
  switch (watch.outcome) {
    case "timedOut":
      return `${link} has not reached a terminal state after ${duration(watch.timeoutMs)}; this watch expired. Run 'codexhost thread watch' again to keep waiting.`;
    case "unreadable":
      return `${link} could not be read for ${Math.round(UNREADABLE_GRACE_MS / 1_000)} s, so its state is unknown (${watch.lastReadError ?? "unknown error"}).`;
    case "notFound":
      return `${link} no longer exists.`;
    default:
      return `${link}: ${watch.outcome}.`;
  }
}

function notification(watches: readonly Watch[]): string {
  return [
    "[codexhost thread watch] Watched Threads stopped or the watch expired. This reports execution state only, not that the work is correct or accepted. Inspect each Thread with 'codexhost thread read <thread>' before relying on it.",
    ...watches.map((watch) => `- ${describe(watch)}`),
  ].join("\n");
}

/**
 * One-shot notifications when a watched Thread stops, built only on the public
 * `read` and `send` operations, so it is independent of Harness, Desktop and
 * delegation lineage. State is in memory: watches do not survive a Host Runtime
 * restart.
 */
export class DelegationWatchService {
  readonly #api: Pick<DelegationControlApi, "read" | "send">;
  readonly #pollIntervalMs: number;
  readonly #diagnose: (error: unknown) => void;
  readonly #watches: Watch[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    api: Pick<DelegationControlApi, "read" | "send">,
    options: { pollIntervalMs?: number; diagnose?: (error: unknown) => void } = {},
  ) {
    this.#api = api;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#diagnose = options.diagnose ?? (() => undefined);
  }

  async watch(input: ThreadWatchInput): Promise<ThreadWatchResult> {
    if (this.#closed) throw new DelegationControlError("INTERNAL_ERROR", "Host Runtime is closing");
    if (typeof input.threadId !== "string" || !input.threadId.trim())
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
    if (typeof input.notifyThreadId !== "string" || !input.notifyThreadId.trim())
      throw new DelegationControlError("INVALID_ARGUMENT", "Notified Thread is required");
    if (input.threadId === input.notifyThreadId)
      throw new DelegationControlError("INVALID_ARGUMENT", "A Thread cannot watch itself");
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
      throw new DelegationControlError("INVALID_ARGUMENT", "timeoutMs must be a positive integer");

    // Both reads reject unknown Threads, so a watch is never reported for a missing end.
    const target = await this.#api.read({ threadId: input.threadId, view: "result" });
    await this.#api.read({ threadId: input.notifyThreadId, view: "result" });
    const result = {
      threadId: input.threadId,
      notifyThreadId: input.notifyThreadId,
      status: target.status,
      timeoutMs: input.timeoutMs,
    };
    if (terminal(target.status)) return { ...result, state: "alreadyTerminal" };
    const existing = this.#watches.find(
      (watch) =>
        watch.state === "watching" &&
        watch.threadId === input.threadId &&
        watch.notifyThreadId === input.notifyThreadId,
    );
    if (existing) return { ...result, state: "watching", timeoutMs: existing.timeoutMs };
    if (this.#closed) throw new DelegationControlError("INTERNAL_ERROR", "Host Runtime is closing");
    this.#watches.push({
      threadId: input.threadId,
      notifyThreadId: input.notifyThreadId,
      state: "watching",
      registeredAt: new Date().toISOString(),
      timeoutMs: input.timeoutMs,
      deadline: Date.now() + input.timeoutMs,
    });
    this.#schedule();
    return { ...result, state: "watching" };
  }

  async watches(): Promise<ThreadWatchListResult> {
    return {
      watches: this.#watches.map(
        ({ threadId, notifyThreadId, state, outcome, reason, registeredAt }) => ({
          threadId,
          notifyThreadId,
          state,
          ...(outcome ? { outcome } : {}),
          ...(reason ? { reason } : {}),
          registeredAt,
        }),
      ),
    };
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#watches.length = 0;
  }

  #schedule(): void {
    if (this.#closed || this.#timer) return;
    if (!this.#watches.some((watch) => watch.state !== "undeliverable")) return;
    this.#timer = setTimeout(() => {
      // A background loop must never take the Host Runtime down with it.
      void this.#tick()
        .catch((error: unknown) => this.#diagnose(error))
        .finally(() => {
          this.#timer = undefined;
          this.#schedule();
        });
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    for (const watch of [...this.#watches]) {
      if (this.#closed) return;
      if (watch.state !== "watching") continue;
      const outcome = await this.#observe(watch);
      if (!outcome) continue;
      watch.state = "pendingDelivery";
      watch.outcome = outcome;
      watch.deliveryDeadline = Date.now() + DELIVERY_WINDOW_MS;
    }
    const subscribers = new Set(
      this.#watches
        .filter((watch) => watch.state === "pendingDelivery")
        .map((watch) => watch.notifyThreadId),
    );
    for (const notifyThreadId of subscribers) {
      if (this.#closed) return;
      await this.#deliver(notifyThreadId);
    }
  }

  async #observe(watch: Watch): Promise<ThreadWatchOutcome | undefined> {
    try {
      const snapshot = await this.#api.read({ threadId: watch.threadId, view: "result" });
      if (terminal(snapshot.status)) return snapshot.status as ThreadWatchOutcome;
      delete watch.unreadableSince;
    } catch (error) {
      if (errorCode(error) === "THREAD_NOT_FOUND") return "notFound";
      // Other read failures may be transient, so only a sustained failure is reported.
      watch.unreadableSince ??= Date.now();
      watch.lastReadError = error instanceof Error ? error.message : String(error);
      if (Date.now() - watch.unreadableSince >= UNREADABLE_GRACE_MS) return "unreadable";
    }
    return Date.now() >= watch.deadline ? "timedOut" : undefined;
  }

  /** All notifications pending for one subscriber start a single Turn. */
  async #deliver(notifyThreadId: string): Promise<void> {
    const pending = this.#watches.filter(
      (watch) => watch.state === "pendingDelivery" && watch.notifyThreadId === notifyThreadId,
    );
    try {
      await this.#api.send({ threadId: notifyThreadId, message: notification(pending) });
      for (const watch of pending) this.#remove(watch);
    } catch (error) {
      const code = errorCode(error);
      const permanent = code === "THREAD_NOT_FOUND" || code === "DELEGATION_FAILED";
      const reason = error instanceof Error ? error.message : String(error);
      for (const watch of pending) {
        // THREAD_BUSY and unknown failures are retried; they are never treated as delivered.
        if (permanent || Date.now() >= (watch.deliveryDeadline ?? 0)) {
          watch.state = "undeliverable";
          watch.reason = reason;
        }
      }
      this.#trimUndeliverable();
    }
  }

  #remove(watch: Watch): void {
    const index = this.#watches.indexOf(watch);
    if (index >= 0) this.#watches.splice(index, 1);
  }

  #trimUndeliverable(): void {
    const undeliverable = this.#watches.filter((watch) => watch.state === "undeliverable");
    for (const watch of undeliverable.slice(0, -MAX_UNDELIVERABLE_ENTRIES)) this.#remove(watch);
  }
}
