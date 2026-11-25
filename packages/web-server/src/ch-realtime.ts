import type { HostClientUpdate } from "@codexhost/desktop-control";
import type { ChHostClient } from "./ch-host-client.ts";

const DEFAULT_DEBOUNCE_MS = 100;

export interface ChRealtimeOptions {
  /** Debounce interval for streaming followed-thread refreshes (defaults to 100ms). */
  threadDebounceMs?: number;
}

function isUrgentThreadChange(method: string): boolean {
  return (
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "thread/status/changed" ||
    method === "serverRequest/resolved" ||
    method === "mcpServer/elicitation/request" ||
    method === "item/tool/requestUserInput" ||
    method === "codexhost/thread/questions/updated" ||
    method === "nativeInteractionError" ||
    method.endsWith("/requestApproval")
  );
}

/** Coalesce invalidations, not tokens. Only followed Threads read bounded absolute
 * state; a change arriving during a read schedules another reconciliation. */
export class ChRealtime {
  private watched = new Map<string, number>();
  private dirty = new Set<string>();
  private urgent = new Set<string>();
  private running = new Set<string>();
  private timers = new Map<string, { handle: ReturnType<typeof setTimeout>; fireAt: number }>();
  private catalogReason: "hello" | "changed" = "changed";
  private readonly threadDebounceMs: number;
  private closed = false;
  private online = false;
  private readonly unsubscribe: () => void;
  constructor(
    host: NonNullable<ChHostClient["realtime"]>,
    private readonly callbacks: {
      thread: (id: string) => Promise<unknown>;
      usage: (id: string) => void;
      catalog: (reason?: "hello" | "changed") => Promise<void>;
      archived?: (id: string, archived: boolean) => void;
      connection: (online: boolean) => void;
      /** `full` is the hello's `reset`: the cursor could not be replayed. */
      reset: (epoch: string, full: boolean) => void;
      error: (id: string, error: unknown) => void;
    },
    options: ChRealtimeOptions = {},
  ) {
    this.threadDebounceMs = Math.max(
      DEFAULT_DEBOUNCE_MS,
      options.threadDebounceMs ?? DEFAULT_DEBOUNCE_MS,
    );
    this.unsubscribe = host.subscribe((event) => this.receive(event));
  }
  invalidate(id: string): void {
    if (this.watched.has(id)) this.schedule(id, DEFAULT_DEBOUNCE_MS);
  }
  follow(id: string): () => void {
    this.watched.set(id, (this.watched.get(id) ?? 0) + 1);
    return () => {
      const count = (this.watched.get(id) ?? 1) - 1;
      if (count) this.watched.set(id, count);
      else this.watched.delete(id);
    };
  }
  private receive(event: HostClientUpdate): void {
    if (this.closed) return;
    if (event.type === "connection") {
      this.online = event.online;
      this.callbacks.connection(event.online);
      if (!event.online) {
        for (const timer of this.timers.values()) clearTimeout(timer.handle);
        this.timers.clear();
        this.urgent.clear();
      }
      return;
    }
    if (event.type === "hello") {
      this.callbacks.reset(event.cursor.epoch, event.reset);
      for (const id of this.watched.keys()) this.schedule(id, DEFAULT_DEBOUNCE_MS);
      if (!this.dirty.has("")) this.catalogReason = "hello";
      this.schedule("", DEFAULT_DEBOUNCE_MS);
    } else if (event.type === "projects-changed") {
      this.schedule("", DEFAULT_DEBOUNCE_MS);
    } else if (event.type === "changed") {
      if (
        event.method === "codexhost/thread/usage/updated" ||
        event.method === "thread/tokenUsage/updated"
      ) {
        if (this.online && this.watched.has(event.threadId)) this.callbacks.usage(event.threadId);
        return;
      }
      if (event.method === "thread/archived" || event.method === "thread/unarchived")
        this.callbacks.archived?.(event.threadId, event.method === "thread/archived");
      if (this.watched.has(event.threadId)) {
        this.schedule(
          event.threadId,
          isUrgentThreadChange(event.method) ? DEFAULT_DEBOUNCE_MS : this.threadDebounceMs,
        );
      }
      if (
        event.method.startsWith("thread/") ||
        event.method === "turn/started" ||
        event.method === "turn/completed" ||
        event.method === "codexhost/thread/pins/changed" ||
        event.method === "codexhost/thread/tree/changed"
      ) {
        this.catalogReason = "changed";
        this.schedule("", DEFAULT_DEBOUNCE_MS);
      }
    }
  }
  private schedule(id: string, delay?: number): void {
    const effectiveDelay = delay ?? (id ? this.threadDebounceMs : DEFAULT_DEBOUNCE_MS);
    this.dirty.add(id);
    if (id && effectiveDelay <= DEFAULT_DEBOUNCE_MS) this.urgent.add(id);
    if (!this.online || this.closed || this.running.has(id)) return;
    const fireAt = Date.now() + effectiveDelay;
    const existing = this.timers.get(id);
    if (existing) {
      if (fireAt >= existing.fireAt) return;
      clearTimeout(existing.handle);
    }
    const handle = setTimeout(() => {
      this.timers.delete(id);
      void this.reconcile(id);
    }, effectiveDelay);
    handle.unref();
    this.timers.set(id, { handle, fireAt });
  }
  private async reconcile(id: string): Promise<void> {
    this.dirty.delete(id);
    this.urgent.delete(id);
    if (this.closed || !this.online || (id && !this.watched.has(id))) return;
    this.running.add(id);
    const catalogReason = id ? undefined : this.catalogReason;
    if (!id) this.catalogReason = "changed";
    let retryDelay: number | undefined;
    try {
      if (id) await this.callbacks.thread(id);
      else await this.callbacks.catalog(catalogReason);
    } catch (error) {
      this.callbacks.error(id, error);
      this.dirty.add(id);
      if (!id && catalogReason === "hello" && this.catalogReason === "changed") {
        this.catalogReason = "hello";
      }
      retryDelay = 1000;
    } finally {
      this.running.delete(id);
      if (this.dirty.has(id)) {
        const nextDelay =
          retryDelay ??
          (id
            ? this.urgent.has(id)
              ? DEFAULT_DEBOUNCE_MS
              : this.threadDebounceMs
            : DEFAULT_DEBOUNCE_MS);
        this.schedule(id, nextDelay);
      }
    }
  }
  close(): void {
    this.closed = true;
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer.handle);
    this.timers.clear();
    this.watched.clear();
    this.dirty.clear();
    this.urgent.clear();
  }
}
