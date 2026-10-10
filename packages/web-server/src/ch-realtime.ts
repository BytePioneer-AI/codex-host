import type { HostClientUpdate } from "@codexhost/desktop-control";
import type { ChHostClient } from "./ch-host-client.ts";

/** Coalesce invalidations, not tokens. Only followed Threads read bounded absolute
 * state; a change arriving during a read schedules another reconciliation. */
export class ChRealtime {
  private watched = new Map<string, number>();
  private dirty = new Set<string>();
  private running = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private online = false;
  private readonly unsubscribe: () => void;
  constructor(
    host: NonNullable<ChHostClient["realtime"]>,
    private readonly callbacks: {
      thread: (id: string) => Promise<unknown>;
      catalog: () => Promise<void>;
      connection: (online: boolean) => void;
      reset: (epoch: string) => void;
      error: (id: string, error: unknown) => void;
    },
  ) {
    this.unsubscribe = host.subscribe((event) => this.receive(event));
  }
  invalidate(id: string): void {
    if (this.watched.has(id)) this.schedule(id);
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
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
      }
      return;
    }
    if (event.type === "hello") {
      this.callbacks.reset(event.cursor.epoch);
      for (const id of this.watched.keys()) this.schedule(id);
      this.schedule("");
    } else {
      if (this.watched.has(event.threadId)) this.schedule(event.threadId);
      if (event.method.startsWith("thread/") || event.method === "turn/completed")
        this.schedule("");
    }
  }
  private schedule(id: string, delay = 100): void {
    this.dirty.add(id);
    if (!this.online || this.closed || this.running.has(id) || this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.reconcile(id);
    }, delay);
    timer.unref();
    this.timers.set(id, timer);
  }
  private async reconcile(id: string): Promise<void> {
    this.dirty.delete(id);
    if (this.closed || !this.online || (id && !this.watched.has(id))) return;
    this.running.add(id);
    let delay = 100;
    try {
      if (id) await this.callbacks.thread(id);
      else await this.callbacks.catalog();
    } catch (error) {
      this.callbacks.error(id, error);
      this.dirty.add(id);
      delay = 1000;
    } finally {
      this.running.delete(id);
      if (this.dirty.has(id)) this.schedule(id, delay);
    }
  }
  close(): void {
    this.closed = true;
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.watched.clear();
    this.dirty.clear();
  }
}
