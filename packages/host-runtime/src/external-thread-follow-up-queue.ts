import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

export type ExternalQueuedSubmission = {
  id: string;
  clientUserMessageId: string;
  input: JsonValue[];
};

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function queuedSubmissionText(input: JsonValue[]): string {
  return input
    .filter(isRecord)
    .map((item) => item.text)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

/** Desktop 26.1021 reads `text_elements.length` on every queued `type: "text"` item. */
export function queuedSubmissionInput(input: JsonValue[]): JsonValue[] {
  return input.map((entry) => {
    if (!isRecord(entry) || typeof entry.text !== "string" || entry.text.length === 0) {
      return entry;
    }
    if (entry.type === "input_text") {
      return {
        type: "text",
        text: entry.text,
        text_elements: Array.isArray(entry.text_elements) ? entry.text_elements : [],
      };
    }
    if (entry.type !== "text" || Array.isArray(entry.text_elements)) return entry;
    return { ...entry, text_elements: [] };
  });
}

/** In-memory Desktop follow-up queue for External Threads. Overlay-owned drain uses this. */
export class ExternalThreadFollowUpQueue {
  readonly #threads = new Map<string, ExternalQueuedSubmission[]>();

  list(threadId: string): { data: ExternalQueuedSubmission[]; nextCursor: null } {
    return { data: [...(this.#threads.get(threadId) ?? [])], nextCursor: null };
  }

  add(
    threadId: string,
    input: JsonValue[],
    clientUserMessageId?: string,
  ): ExternalQueuedSubmission {
    const item: ExternalQueuedSubmission = {
      id: randomUUID(),
      clientUserMessageId: clientUserMessageId?.trim() || randomUUID(),
      input: queuedSubmissionInput(input),
    };
    const items = this.#threads.get(threadId) ?? [];
    items.push(item);
    this.#threads.set(threadId, items);
    return item;
  }

  update(threadId: string, id: string, input: JsonValue[]): ExternalQueuedSubmission | undefined {
    const item = this.#threads.get(threadId)?.find((entry) => entry.id === id);
    if (!item) return undefined;
    item.input = queuedSubmissionInput(input);
    return item;
  }

  delete(threadId: string, id: string): boolean {
    const items = this.#threads.get(threadId);
    if (!items) return false;
    const next = items.filter((entry) => entry.id !== id);
    if (next.length === items.length) return false;
    if (next.length === 0) this.#threads.delete(threadId);
    else this.#threads.set(threadId, next);
    return true;
  }

  reorder(threadId: string, ids: string[]): boolean {
    const items = this.#threads.get(threadId);
    if (!items) return false;
    const remaining = new Map(items.map((entry) => [entry.id, entry]));
    const next: ExternalQueuedSubmission[] = [];
    for (const id of ids) {
      const item = remaining.get(id);
      if (!item) return false;
      next.push(item);
      remaining.delete(id);
    }
    next.push(...remaining.values());
    this.#threads.set(threadId, next);
    return true;
  }

  peek(threadId: string, id?: string): ExternalQueuedSubmission | undefined {
    const items = this.#threads.get(threadId);
    if (!items?.length) return undefined;
    return id ? items.find((entry) => this.#matches(entry, id)) : items[0];
  }

  take(threadId: string, id?: string): ExternalQueuedSubmission | undefined {
    const items = this.#threads.get(threadId);
    if (!items?.length) return undefined;
    const index = id ? items.findIndex((entry) => this.#matches(entry, id)) : 0;
    if (index < 0) return undefined;
    const [item] = items.splice(index, 1);
    if (items.length === 0) this.#threads.delete(threadId);
    return item;
  }

  restore(threadId: string, item: ExternalQueuedSubmission): void {
    const items = this.#threads.get(threadId) ?? [];
    items.unshift(item);
    this.#threads.set(threadId, items);
  }

  #matches(entry: ExternalQueuedSubmission, id: string): boolean {
    return entry.id === id || entry.clientUserMessageId === id;
  }
}
