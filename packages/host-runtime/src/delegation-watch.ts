import { randomUUID } from "node:crypto";

import { formatThreadWatchNotice } from "@codexhost/shared-contracts";

import {
  DEFAULT_WATCH_TIMEOUT_MS,
  DelegationControlError,
  type DelegationControlApi,
  type DelegationThreadSnapshot,
  type ThreadCancelResult,
  type ThreadWatchInput,
  type ThreadWatchListResult,
  type ThreadWatchOutcome,
  type ThreadWatchResult,
} from "./delegation-types.js";
import type { DelegationWatchStore, PersistedWatch } from "./delegation-watch-store.js";
import { threadWatchLabel } from "./delegation-title.js";
import type { NewClientEvent } from "./external-client-events.js";
import { originClientName } from "./external-client-origin.js";
import { isValidClientName } from "./external-clients.js";

/** Where notifications for an external client go instead of a new Turn. */
export interface ClientEventSink {
  append(client: string, events: readonly NewClientEvent[]): Promise<unknown>;
}

export { DEFAULT_WATCH_TIMEOUT_MS };
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** How long a fired notification may wait for a busy or unreachable subscriber. */
const DELIVERY_WINDOW_MS = 6 * 60 * 60_000;
const MAX_UNDELIVERABLE_ENTRIES = 50;
/** Reads failing for this long are reported instead of waiting for the timeout. */
const UNREADABLE_GRACE_MS = 60_000;
/** After a restart, how long restored watches wait for their Host sessions to register again. */
const DEFAULT_RESTORE_GRACE_MS = 5 * 60_000;

interface Watch extends PersistedWatch {
  /** Invalidates reads that overlapped an internal stop-and-resend operation. */
  observationGeneration?: number;
  unreadableSince?: number;
  lastReadError?: string;
  /** Restored watch: read failures mean the owning session is not back yet. */
  observeGraceUntil?: number;
  /** Restored watch: deliver only once the notified Thread is readable again. */
  deliverGraceUntil?: number;
  /** Restored while watching: the Turn that was running may have been cut off by the restart. */
  crossedRestart?: boolean;
}

function persisted(watch: Watch): PersistedWatch {
  const {
    id,
    threadId,
    notifyThreadId,
    state,
    outcome,
    turnId,
    interactionId,
    reason,
    registeredAt,
    timeoutMs,
    deadline,
    deliveryDeadline,
    delivering,
    restartNote,
    title,
    harnessId,
    refs,
  } = watch;
  return {
    id,
    threadId,
    notifyThreadId,
    state,
    registeredAt,
    timeoutMs,
    deadline,
    ...(outcome ? { outcome } : {}),
    ...(turnId ? { turnId } : {}),
    ...(interactionId ? { interactionId } : {}),
    ...(reason ? { reason } : {}),
    ...(deliveryDeadline !== undefined ? { deliveryDeadline } : {}),
    ...(delivering ? { delivering } : {}),
    ...(restartNote ? { restartNote } : {}),
    ...(title ? { title } : {}),
    ...(harnessId ? { harnessId } : {}),
    ...(refs?.length ? { refs } : {}),
  };
}

function terminal(status: DelegationThreadSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof DelegationControlError ? error.code : undefined;
}

/**
 * A failed send is retried only when the call chain proves no Turn started.
 * - permanent: the notified Thread is missing or read-only; retrying cannot help.
 * - rejected: THREAD_BUSY is decided before any start, and `notStarted` marks a
 *   start the target explicitly refused, so a retry cannot duplicate it.
 * - unknown: anything else. A structured error is not proof: an adapter may
 *   report a timed-out start whose native Turn was accepted, so a retry could
 *   deliver the notification twice.
 */
function deliveryFailure(error: unknown): "permanent" | "rejected" | "unknown" {
  if (!(error instanceof DelegationControlError)) return "unknown";
  if (error.code === "THREAD_NOT_FOUND" || error.details?.readOnly === true) return "permanent";
  if (error.code === "THREAD_BUSY" || error.details?.notStarted === true) return "rejected";
  return "unknown";
}

function threadLink(threadId: string): string {
  return `codex://threads/${threadId}`;
}

function duration(milliseconds: number): string {
  return milliseconds < 60_000
    ? `${Math.round(milliseconds / 1_000)} s`
    : `${Math.round(milliseconds / 60_000)} min`;
}

function noticeNote(watch: Watch): string | undefined {
  switch (watch.outcome) {
    case "needsInput": {
      // The request ID lets the receiver answer without guessing which Question fired.
      const request = watch.interactionId
        ? `, request ${watch.interactionId}${watch.turnId ? `, Turn ${watch.turnId}` : ""}`
        : "";
      return `Waiting for an answer${request}. Read the current Question with 'codexhost thread read ${watch.threadId}' and answer it with 'codexhost thread answer <thread> --interaction <id> --answers-file <file>'.`;
    }
    case "timedOut":
      return `Not stopped after ${duration(watch.timeoutMs)}; run 'codexhost thread watch' again to keep waiting.`;
    case "unreadable":
      return `Could not be read for ${Math.round(UNREADABLE_GRACE_MS / 1_000)} s, so its state is unknown (${watch.lastReadError ?? "unknown error"}).`;
    case "notFound":
      return "The Thread no longer exists.";
    case "interrupted":
      return watch.restartNote;
    default:
      return undefined;
  }
}

function notification(watches: readonly Watch[]): string {
  return formatThreadWatchNotice(
    watches.map((watch) => {
      const note = noticeNote(watch);
      return {
        threadId: watch.threadId,
        label: threadWatchLabel(watch.title, watch.threadId),
        // Only pending deliveries, whose outcome has been observed, are notified.
        outcome: watch.outcome as ThreadWatchOutcome,
        ...(note ? { note } : {}),
      };
    }),
  );
}

/**
 * One-shot notifications when a watched Thread stops, built only on the public
 * `read` and `send` operations, so it is independent of Harness, Desktop and
 * delegation lineage. With a store, watches survive a Host Runtime restart: a
 * send whose outcome was not recorded before the restart is made again, so a
 * restart may repeat a notification but does not lose one.
 */
export class DelegationWatchService {
  readonly #api: Pick<DelegationControlApi, "read" | "send">;
  readonly #pollIntervalMs: number;
  readonly #diagnose: (error: unknown) => void;
  readonly #store: DelegationWatchStore | undefined;
  readonly #clientEvents: ClientEventSink | undefined;
  readonly #restoreGraceMs: number;
  readonly #ready: Promise<void>;
  readonly #watches: Watch[] = [];
  readonly #cancelling = new Map<string, number>();
  #writes: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    api: Pick<DelegationControlApi, "read" | "send">,
    options: {
      pollIntervalMs?: number;
      diagnose?: (error: unknown) => void;
      store?: DelegationWatchStore;
      clientEvents?: ClientEventSink;
      restoreGraceMs?: number;
    } = {},
  ) {
    this.#api = api;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#diagnose = options.diagnose ?? (() => undefined);
    this.#store = options.store;
    this.#clientEvents = options.clientEvents;
    this.#restoreGraceMs = options.restoreGraceMs ?? DEFAULT_RESTORE_GRACE_MS;
    this.#ready = this.#store ? this.#restore(this.#store) : Promise.resolve();
  }

  async watch(input: ThreadWatchInput): Promise<ThreadWatchResult> {
    await this.#ready;
    if (this.#closed) throw new DelegationControlError("INTERNAL_ERROR", "Host Runtime is closing");
    if (typeof input.threadId !== "string" || !input.threadId.trim())
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
    if (typeof input.notifyThreadId !== "string" || !input.notifyThreadId.trim())
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Notified Thread is required; pass --notify <thread>",
      );
    if (input.threadId === input.notifyThreadId)
      throw new DelegationControlError("INVALID_ARGUMENT", "A Thread cannot watch itself");
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
      throw new DelegationControlError("INVALID_ARGUMENT", "timeoutMs must be a positive integer");

    const client = originClientName(input.notifyThreadId);
    if (client !== undefined && (!isValidClientName(client) || !this.#clientEvents))
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "The notified client is invalid or this Runtime keeps no client events",
      );
    // Both reads reject unknown Threads, so a watch is never reported for a missing end.
    const target = await this.#api.read({ threadId: input.threadId, view: "result" });
    if (client === undefined)
      await this.#api.read({ threadId: input.notifyThreadId, view: "result" });
    const result = {
      threadId: input.threadId,
      notifyThreadId: input.notifyThreadId,
      status: target.status,
      timeoutMs: input.timeoutMs,
    };
    if (terminal(target.status)) return { ...result, state: "alreadyTerminal" };
    // A Question already waiting needs no watch: report it once, immediately,
    // instead of registering a notification the caller would get anyway.
    if (target.pendingQuestions?.length) {
      return {
        ...result,
        state: "alreadyNeedsInput",
        pendingQuestions: target.pendingQuestions,
      };
    }
    const existing = this.#watches.find(
      (watch) =>
        watch.state === "watching" &&
        watch.threadId === input.threadId &&
        watch.notifyThreadId === input.notifyThreadId,
    );
    if (existing) return { ...result, state: "watching", timeoutMs: existing.timeoutMs };
    if (this.#closed) throw new DelegationControlError("INTERNAL_ERROR", "Host Runtime is closing");
    const watch: Watch = {
      id: randomUUID(),
      threadId: input.threadId,
      notifyThreadId: input.notifyThreadId,
      state: "watching",
      registeredAt: new Date().toISOString(),
      timeoutMs: input.timeoutMs,
      deadline: Date.now() + input.timeoutMs,
      ...(target.title ? { title: target.title } : {}),
    };
    this.#watches.push(watch);
    try {
      await this.#persist(watch, true);
    } catch (error) {
      const index = this.#watches.indexOf(watch);
      if (index >= 0) this.#watches.splice(index, 1);
      throw new DelegationControlError(
        "INTERNAL_ERROR",
        `Could not persist Thread watch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#schedule();
    return { ...result, state: "watching" };
  }

  async watches(): Promise<ThreadWatchListResult> {
    await this.#ready;
    const watches = [...this.#watches];
    const snapshots = new Map<string, DelegationThreadSnapshot | undefined>();
    await Promise.all(
      [...new Set(watches.map(({ threadId }) => threadId))].map(async (threadId) => {
        try {
          snapshots.set(threadId, await this.#api.read({ threadId, view: "result" }));
        } catch {
          // A missing or temporarily unreadable Thread must not hide its watch.
        }
      }),
    );
    const now = Date.now();
    return {
      watches: watches
        .filter((watch) => this.#watches.includes(watch))
        .map(
          ({
            threadId,
            notifyThreadId,
            state,
            outcome,
            turnId,
            interactionId,
            reason,
            registeredAt,
            title,
          }) => {
            const snapshot = snapshots.get(threadId);
            const taskName = snapshot?.title || title;
            const registeredMs = Date.parse(registeredAt);
            return {
              threadId,
              notifyThreadId,
              state,
              ...(outcome ? { outcome } : {}),
              ...(turnId ? { turnId } : {}),
              ...(interactionId ? { interactionId } : {}),
              ...(reason ? { reason } : {}),
              registeredAt,
              ...(taskName ? { taskName } : {}),
              ...(snapshot ? { threadStatus: snapshot.status } : {}),
              ...(Number.isFinite(registeredMs)
                ? { watchedForMs: Math.max(0, now - registeredMs) }
                : {}),
            };
          },
        ),
    };
  }

  /** Hold notifications until cancellation is decided; only an accepted cancel drops watches. */
  async cancel(
    threadId: string,
    operation: () => Promise<ThreadCancelResult>,
  ): Promise<ThreadCancelResult> {
    return this.holdNotifications(threadId, async () => {
      const result = await operation();
      if (result.cancelled) {
        for (const watch of [...this.#watches]) {
          if (watch.threadId === threadId) this.#remove(watch);
        }
        // Flush ordered removals before acknowledging, using the normal diagnostic-only I/O errors.
        await this.#writes;
      }
      return result;
    });
  }

  /** Internal stop-and-resend is not a stop: keep watches and suppress transient outcomes. */
  async holdNotifications<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    this.#cancelling.set(threadId, (this.#cancelling.get(threadId) ?? 0) + 1);
    try {
      await this.#ready;
      for (const watch of this.#watches) {
        if (watch.threadId === threadId)
          watch.observationGeneration = (watch.observationGeneration ?? 0) + 1;
      }
      return await operation();
    } finally {
      const remaining = (this.#cancelling.get(threadId) ?? 1) - 1;
      if (remaining > 0) this.#cancelling.set(threadId, remaining);
      else this.#cancelling.delete(threadId);
    }
  }

  /** Stops work in this process. Stored watches stay on disk for the next Runtime. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#watches.length = 0;
  }

  async #restore(store: DelegationWatchStore): Promise<void> {
    let records: PersistedWatch[];
    try {
      records = await store.adopt();
    } catch (error) {
      this.#diagnose(error);
      return;
    }
    if (this.#closed) return;
    const now = Date.now();
    const graceUntil = now + this.#restoreGraceMs;
    for (const record of records) {
      const watch: Watch = { ...record };
      // The send may or may not have started a Turn before the restart; deliver again.
      delete watch.delivering;
      if (watch.state === "watching") {
        watch.observeGraceUntil = graceUntil;
        watch.crossedRestart = true;
      }
      if (watch.state === "pendingDelivery" && now >= (watch.deliveryDeadline ?? 0)) {
        watch.state = "undeliverable";
        watch.reason = "The delivery window ended while the Host Runtime was stopped";
      }
      if (watch.state !== "undeliverable") watch.deliverGraceUntil = graceUntil;
      this.#watches.push(watch);
      if (record.delivering || watch.state !== record.state) void this.#persist(watch);
    }
    this.#trimUndeliverable();
    if (records.length > 0) this.#diagnose(`restored ${records.length} watch(es) after a restart`);
    this.#schedule();
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
      if (watch.state !== "watching" || this.#cancelling.has(watch.threadId)) continue;
      const generation = watch.observationGeneration;
      const observed = await this.#observe(watch);
      if (
        !observed ||
        !this.#watches.includes(watch) ||
        this.#cancelling.has(watch.threadId) ||
        generation !== watch.observationGeneration
      )
        continue;
      const { outcome, turnId, restartNote, interactionId } = observed;
      if (restartNote) watch.restartNote = restartNote;
      watch.state = "pendingDelivery";
      watch.outcome = outcome;
      if (turnId) watch.turnId = turnId;
      if (interactionId) watch.interactionId = interactionId;
      watch.deliveryDeadline = Date.now() + DELIVERY_WINDOW_MS;
      await this.#persist(watch);
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

  async #observe(
    watch: Watch,
  ): Promise<
    | { outcome: ThreadWatchOutcome; turnId?: string; restartNote?: string; interactionId?: string }
    | undefined
  > {
    try {
      const snapshot = await this.#api.read({ threadId: watch.threadId, view: "result" });
      delete watch.observeGraceUntil;
      const turnId = snapshot.turn?.turnId;
      const crossedRestart = watch.crossedRestart === true;
      delete watch.crossedRestart;
      if (snapshot.title) watch.title = snapshot.title;
      watch.harnessId = snapshot.harnessId;
      if (snapshot.refs?.length) watch.refs = snapshot.refs;
      if (terminal(snapshot.status)) {
        // A restart ends the Harness processes it owned. The Turn that was running can then read
        // as completed, sometimes under a new Turn id, so a Thread that was running before the
        // restart and is terminal on the first read after it is reported as interrupted.
        if (crossedRestart)
          return {
            outcome: "interrupted",
            ...(turnId ? { turnId } : {}),
            restartNote: `The Host Runtime restarted while this Thread was running; afterwards it read as ${snapshot.status}, so the work most likely did not finish. Read it, then continue it or start it again.`,
          };
        return {
          outcome: snapshot.status as ThreadWatchOutcome,
          ...(turnId ? { turnId } : {}),
        };
      }
      const pending = snapshot.pendingQuestions?.[0];
      if (pending) {
        // A Question outranks the deadline even when its native Turn can keep
        // working; the request names the Turn that can receive the answer.
        return {
          outcome: "needsInput",
          interactionId: pending.interactionId,
          turnId: pending.turnId,
        };
      }
      delete watch.unreadableSince;
    } catch (error) {
      if (watch.observeGraceUntil !== undefined) {
        // Until the session that owns the Thread registers again, a failed read says nothing.
        if (Date.now() < watch.observeGraceUntil) return undefined;
        delete watch.observeGraceUntil;
      }
      if (errorCode(error) === "THREAD_NOT_FOUND") {
        // A Harness may be unable to reopen a session whose Turn the restart cut off.
        if (watch.crossedRestart)
          return {
            outcome: "interrupted",
            restartNote: `The Host Runtime restarted while this Thread was running, and the Thread could not be opened again (${error instanceof Error ? error.message : String(error)}).`,
          };
        return { outcome: "notFound" };
      }
      // Other read failures may be transient, so only a sustained failure is reported.
      watch.unreadableSince ??= Date.now();
      watch.lastReadError = error instanceof Error ? error.message : String(error);
      if (Date.now() - watch.unreadableSince >= UNREADABLE_GRACE_MS)
        return { outcome: "unreadable" };
    }
    return Date.now() >= watch.deadline ? { outcome: "timedOut" } : undefined;
  }

  /** All notifications pending for one subscriber start a single Turn. */
  async #deliver(notifyThreadId: string): Promise<void> {
    let pending = this.#watches.filter(
      (watch) => this.#deliverable(watch) && watch.notifyThreadId === notifyThreadId,
    );
    if (pending.length === 0) return;
    const client = originClientName(notifyThreadId);
    if (client !== undefined) {
      await this.#deliverToClient(client, pending);
      return;
    }
    if (!(await this.#subscriberReady(notifyThreadId, pending))) return;
    pending = pending.filter((watch) => this.#deliverable(watch));
    if (pending.length === 0) return;
    for (const watch of pending) watch.delivering = true;
    // Recorded before sending, so a restart during the send delivers again instead of losing it.
    await Promise.all(pending.map((watch) => this.#persist(watch)));
    pending = pending.filter((watch) => this.#deliverable(watch));
    if (pending.length === 0) return;
    try {
      await this.#api.send({ threadId: notifyThreadId, message: notification(pending) });
      for (const watch of pending) this.#remove(watch);
    } catch (error) {
      const failure = deliveryFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      for (const watch of pending) {
        delete watch.delivering;
        // A rejected send is retried and never treated as delivered.
        if (failure !== "rejected" || Date.now() >= (watch.deliveryDeadline ?? 0)) {
          watch.state = "undeliverable";
          watch.reason =
            failure === "unknown"
              ? `Delivery outcome unknown; the notification may already have started a Turn, so it is not retried (${message})`
              : message;
        }
        void this.#persist(watch);
      }
      this.#trimUndeliverable();
    }
  }

  /**
   * A client's notification is an event appended to its log. The append either
   * lands or fails locally, so a failure is retried within the delivery window.
   */
  async #deliverToClient(client: string, pending: readonly Watch[]): Promise<void> {
    for (const watch of pending) delete watch.deliverGraceUntil;
    try {
      if (!this.#clientEvents) throw new Error("This Runtime keeps no client events");
      await this.#clientEvents.append(
        client,
        pending.map((watch) => ({
          type: "watch" as const,
          threadId: watch.threadId,
          outcome: watch.outcome ?? "notFound",
          deepLink: threadLink(watch.threadId),
          ...(watch.turnId ? { turnId: watch.turnId } : {}),
          ...(watch.outcome === "needsInput" && watch.interactionId
            ? { interactionId: watch.interactionId }
            : {}),
          ...(watch.harnessId ? { harnessId: watch.harnessId } : {}),
          ...(watch.refs?.length ? { refs: watch.refs } : {}),
          ...(watch.restartNote ? { note: watch.restartNote } : {}),
        })),
      );
      for (const watch of pending) this.#remove(watch);
    } catch (error) {
      this.#diagnose(error);
      for (const watch of pending) {
        if (Date.now() < (watch.deliveryDeadline ?? 0)) continue;
        watch.state = "undeliverable";
        watch.reason = error instanceof Error ? error.message : String(error);
        void this.#persist(watch);
      }
      this.#trimUndeliverable();
    }
  }

  /** Restored notifications wait until the notified Thread can be reached again. */
  async #subscriberReady(notifyThreadId: string, pending: readonly Watch[]): Promise<boolean> {
    const restored = pending.filter((watch) => watch.deliverGraceUntil !== undefined);
    if (restored.length === 0) return true;
    if (restored.some((watch) => Date.now() < (watch.deliverGraceUntil ?? 0))) {
      try {
        await this.#api.read({ threadId: notifyThreadId, view: "result" });
      } catch {
        return false;
      }
    }
    for (const watch of restored) delete watch.deliverGraceUntil;
    return true;
  }

  #deliverable(watch: Watch): boolean {
    return (
      !this.#closed &&
      this.#watches.includes(watch) &&
      watch.state === "pendingDelivery" &&
      !this.#cancelling.has(watch.threadId)
    );
  }

  #persist(watch: Watch, required = false): Promise<void> {
    // An asynchronous observation or delivery may still hold a removed watch.
    if (!this.#watches.includes(watch)) return Promise.resolve();
    const record = persisted(watch);
    return this.#write((store) => store.save(record), required);
  }

  #write(
    operation: (store: DelegationWatchStore) => Promise<void>,
    required = false,
  ): Promise<void> {
    const store = this.#store;
    if (!store) return Promise.resolve();
    // Writes run in order, so a later state of a watch is never overwritten by an earlier one.
    const next = this.#writes.then(() => operation(store));
    this.#writes = next.catch((error: unknown) => this.#diagnose(error));
    return required ? next : this.#writes;
  }

  #remove(watch: Watch): void {
    const index = this.#watches.indexOf(watch);
    if (index >= 0) this.#watches.splice(index, 1);
    void this.#write((store) => store.remove(watch.id));
  }

  #trimUndeliverable(): void {
    const undeliverable = this.#watches.filter((watch) => watch.state === "undeliverable");
    for (const watch of undeliverable.slice(0, -MAX_UNDELIVERABLE_ENTRIES)) this.#remove(watch);
  }
}
