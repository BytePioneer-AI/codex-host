import { randomUUID } from "node:crypto";

import type { JsonObject } from "@codexhost/protocol-core";

export class ExternalQueueError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type ExternalQueuePausedReason = "interrupted" | "outcome-unknown" | "failed";

export interface ExternalQueuedSubmission extends JsonObject {
  id: string;
  clientUserMessageId: string;
  input: JsonObject[];
  presentationInput: JsonObject[] | null;
  sourceHostId: string | null;
}

export interface ExternalThreadQueueSnapshot {
  items: ExternalQueuedSubmission[];
  pausedReason: ExternalQueuePausedReason | null;
}

export function nativeQueuedSubmission(item: ExternalQueuedSubmission): JsonObject {
  return {
    id: item.id,
    clientUserMessageId: item.clientUserMessageId,
    // Desktop's queue parser requires text_elements; preserve explicit native annotations.
    input: item.input.map((part) =>
      part.type === "text" ? { ...part, text_elements: part.text_elements ?? [] } : part,
    ),
  };
}

const MAX_QUEUED_SUBMISSIONS = 32;

function sameInput(left: JsonObject[], right: JsonObject[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Process-owned queue for external Threads. Desktop and Web mutate this same state. */
export class ExternalThreadQueue {
  readonly #receipts = new Map<string, ExternalQueuedSubmission>();
  readonly #states = new Map<
    string,
    { items: ExternalQueuedSubmission[]; pausedReason: ExternalQueuePausedReason | null }
  >();

  snapshot(threadId: string): ExternalThreadQueueSnapshot {
    const state = this.#states.get(threadId);
    return {
      items: state?.items.map((item) => structuredClone(item)) ?? [],
      pausedReason: state?.pausedReason ?? null,
    };
  }

  list(threadId: string, params: JsonObject): JsonObject {
    const items = this.#states.get(threadId)?.items ?? [];
    const start = params.cursor == null ? 0 : Number(params.cursor);
    if (!Number.isSafeInteger(start) || start < 0 || start > items.length)
      throw new ExternalQueueError(-32602, "Invalid thread/queue/list cursor");
    const limit =
      typeof params.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0
        ? params.limit
        : 50;
    const end = Math.min(items.length, start + limit);
    return {
      data: items.slice(start, end).map((item) => nativeQueuedSubmission(structuredClone(item))),
      nextCursor: end < items.length ? String(end) : null,
    };
  }

  add(
    threadId: string,
    input: JsonObject[],
    clientUserMessageId?: string,
    presentationInput?: JsonObject[],
    sourceHostId?: unknown,
  ): ExternalQueuedSubmission {
    if (clientUserMessageId) {
      const existing = this.#receipts.get(this.#receiptKey(threadId, clientUserMessageId));
      if (existing) {
        if (
          !sameInput(existing.input, input) ||
          JSON.stringify(existing.presentationInput) !== JSON.stringify(presentationInput ?? null)
        )
          throw new Error("Message ID was already used with different input");
        return structuredClone(existing);
      }
    }
    const state = this.#state(threadId);
    if (state.items.length >= MAX_QUEUED_SUBMISSIONS)
      throw new Error("External Thread queue is full");
    const item: ExternalQueuedSubmission = {
      id: randomUUID(),
      clientUserMessageId: clientUserMessageId ?? randomUUID(),
      input: structuredClone(input),
      presentationInput: presentationInput ? structuredClone(presentationInput) : null,
      sourceHostId: typeof sourceHostId === "string" ? sourceHostId : null,
    };
    state.items.push(item);
    if (clientUserMessageId) {
      this.#receipts.set(this.#receiptKey(threadId, clientUserMessageId), item);
      if (this.#receipts.size > 256) {
        const oldest = this.#receipts.keys().next();
        if (!oldest.done) this.#receipts.delete(oldest.value);
      }
    }
    return structuredClone(item);
  }

  update(
    threadId: string,
    itemId: string,
    input: JsonObject[],
    presentationInput?: JsonObject[],
  ): ExternalQueuedSubmission | null {
    const state = this.#states.get(threadId);
    const item = state?.items.find((candidate) => candidate.id === itemId);
    if (!item) return null;
    item.input = structuredClone(input);
    item.presentationInput = presentationInput ? structuredClone(presentationInput) : null;
    const receipt = this.#receipts.get(this.#receiptKey(threadId, item.clientUserMessageId));
    if (receipt) {
      receipt.input = structuredClone(input);
      receipt.presentationInput = presentationInput ? structuredClone(presentationInput) : null;
    }
    return structuredClone(item);
  }

  delete(threadId: string, itemId: string): boolean {
    const state = this.#states.get(threadId);
    if (!state) return false;
    const index = state.items.findIndex((item) => item.id === itemId);
    if (index < 0) return false;
    state.items.splice(index, 1);
    this.#prune(threadId, state);
    return true;
  }

  reorder(threadId: string, itemIds: string[]): boolean {
    const state = this.#states.get(threadId);
    if (!state) return itemIds.length === 0;
    if (itemIds.length > state.items.length) return false;
    const byId = new Map(state.items.map((item) => [item.id, item]));
    if (new Set(itemIds).size !== itemIds.length) return false;
    const reordered: ExternalQueuedSubmission[] = [];
    for (const id of itemIds) {
      const item = byId.get(id);
      if (!item) return false;
      reordered.push(item);
      byId.delete(id);
    }
    state.items = [...reordered, ...byId.values()];
    return true;
  }

  find(threadId: string, itemId: string): ExternalQueuedSubmission | null {
    const item = this.#states.get(threadId)?.items.find((candidate) => candidate.id === itemId);
    return item ? structuredClone(item) : null;
  }

  head(threadId: string): ExternalQueuedSubmission | null {
    const item = this.#states.get(threadId)?.items[0];
    return item ? structuredClone(item) : null;
  }

  pause(threadId: string, reason: ExternalQueuePausedReason): boolean {
    const state = this.#states.get(threadId);
    if (!state?.items.length || state.pausedReason === reason) return false;
    state.pausedReason = reason;
    return true;
  }

  resume(threadId: string): boolean {
    const state = this.#states.get(threadId);
    if (!state || state.pausedReason === null) return false;
    state.pausedReason = null;
    return true;
  }

  isPaused(threadId: string): boolean {
    return this.#states.get(threadId)?.pausedReason != null;
  }

  has(threadId: string): boolean {
    return (this.#states.get(threadId)?.items.length ?? 0) > 0;
  }

  clear(threadId: string): void {
    this.#states.delete(threadId);
    const prefix = `${threadId}\u0000`;
    for (const key of this.#receipts.keys()) if (key.startsWith(prefix)) this.#receipts.delete(key);
  }

  #receiptKey(threadId: string, clientUserMessageId: string): string {
    return `${threadId}\u0000${clientUserMessageId}`;
  }

  #state(threadId: string) {
    let state = this.#states.get(threadId);
    if (!state) {
      state = { items: [], pausedReason: null };
      this.#states.set(threadId, state);
    }
    return state;
  }

  #prune(
    threadId: string,
    state: { items: ExternalQueuedSubmission[]; pausedReason: ExternalQueuePausedReason | null },
  ): void {
    if (state.items.length === 0) this.#states.delete(threadId);
  }
}
