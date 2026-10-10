import { randomUUID } from "node:crypto";
import type { ClientChannelCursor, ClientChannelEvent } from "@codexhost/shared-contracts";

/** Bounded, process-local invalidation journal. No transcript or independent
 * Session ownership is stored here. Slow listeners detach instead of blocking GUI. */
export class ClientChannelEvents {
  readonly epoch = randomUUID();
  private sequence = 0;
  private history: Array<Extract<ClientChannelEvent, { type: "changed" }>> = [];
  private listeners = new Set<(event: ClientChannelEvent) => void>();
  constructor(private readonly capacity = 512) {}
  get cursor(): ClientChannelCursor {
    return { epoch: this.epoch, sequence: this.sequence };
  }
  changed(threadId: string, method: string): void {
    const event: Extract<ClientChannelEvent, { type: "changed" }> = {
      type: "changed",
      cursor: { epoch: this.epoch, sequence: ++this.sequence },
      threadId,
      method,
    };
    this.history.push(event);
    if (this.history.length > this.capacity) this.history.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
  subscribe(
    listener: (event: ClientChannelEvent) => void,
    after?: ClientChannelCursor,
  ): () => void {
    const cursor = this.cursor;
    const oldest = this.history[0]?.cursor.sequence ?? cursor.sequence + 1;
    const replay =
      after?.epoch === cursor.epoch &&
      after.sequence >= oldest - 1 &&
      after.sequence <= cursor.sequence;
    listener({ type: "hello", version: 1, cursor, reset: !replay });
    if (replay)
      for (const event of this.history) if (event.cursor.sequence > after.sequence) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  clear(): void {
    this.listeners.clear();
    this.history = [];
  }
}
