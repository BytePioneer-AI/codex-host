import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

/** Official app-server `QueuedSubmission`. */
export interface QueuedSubmission {
  id: string;
  input: JsonValue[];
  clientUserMessageId: string;
}

export class ExternalQueueError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface QueueEntry extends QueuedSubmission {
  sourceHostId: string | undefined;
}
interface TakenSubmission {
  submission: QueuedSubmission;
  sourceHostId: string | undefined;
  index: number;
}

/** Keep Host context out of every official queue response, including add/update. */
const publicSubmission = ({
  id,
  input,
  clientUserMessageId,
}: QueuedSubmission): QueuedSubmission => ({
  id,
  input,
  clientUserMessageId,
});

const DEFAULT_PAGE_SIZE = 50;

/**
 * Follow-ups Desktop queues on an External Thread through the official `thread/queue/*`
 * protocol. Desktop keeps no local copy: it lists the queue after every
 * `thread/queue/changed` and leaves the next submission to the Host once a Turn completes.
 * Entries live for the Host process; the Harness Session holds no queued input.
 */
export class ExternalThreadQueue {
  readonly #queues = new Map<string, QueueEntry[]>();
  readonly #notifyChanged: (threadId: string) => Promise<void>;
  readonly #createId: () => string;

  constructor(options: {
    notifyChanged(threadId: string): Promise<void>;
    createId?: () => string;
  }) {
    this.#notifyChanged = options.notifyChanged;
    this.#createId = options.createId ?? randomUUID;
  }

  has(threadId: string): boolean {
    return (this.#queues.get(threadId)?.length ?? 0) > 0;
  }

  list(threadId: string, params: JsonObject): JsonObject {
    const items = this.#queues.get(threadId) ?? [];
    const start = params.cursor == null ? 0 : Number(params.cursor);
    if (!Number.isSafeInteger(start) || start < 0 || start > items.length) {
      throw new ExternalQueueError(-32602, "Invalid thread/queue/list cursor");
    }
    const limit =
      typeof params.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0
        ? params.limit
        : DEFAULT_PAGE_SIZE;
    const end = Math.min(items.length, start + limit);
    return {
      data: items.slice(start, end).map((item) => publicSubmission(item) as unknown as JsonObject),
      nextCursor: end < items.length ? String(end) : null,
    };
  }

  async add(
    threadId: string,
    input: JsonValue[],
    clientUserMessageId: string,
    sourceHostId?: string,
  ): Promise<QueuedSubmission> {
    const submission = { id: this.#createId(), input, clientUserMessageId, sourceHostId };
    this.#items(threadId).push(submission);
    await this.#notifyChanged(threadId);
    return publicSubmission(submission);
  }

  async update(threadId: string, id: string, input: JsonValue[]): Promise<QueuedSubmission> {
    const items = this.#queues.get(threadId) ?? [];
    const index = items.findIndex((item) => item.id === id);
    const current = items[index];
    if (!current) throw new ExternalQueueError(-32602, "Queued submission was not found");
    const submission = { ...current, input };
    items[index] = submission;
    await this.#notifyChanged(threadId);
    return publicSubmission(submission);
  }

  async delete(threadId: string, id: string): Promise<boolean> {
    const items = this.#queues.get(threadId);
    const index = items?.findIndex((item) => item.id === id) ?? -1;
    if (!items || index === -1) return false;
    items.splice(index, 1);
    this.#prune(threadId);
    await this.#notifyChanged(threadId);
    return true;
  }

  /** Listed IDs move to the front in the given order; unlisted entries keep their order. */
  async reorder(threadId: string, ids: readonly string[]): Promise<void> {
    const items = this.#queues.get(threadId);
    if (!items) return;
    const byId = new Map(items.map((item) => [item.id, item]));
    const ordered = ids.flatMap((id) => {
      const item = byId.get(id);
      byId.delete(id);
      return item ? [item] : [];
    });
    items.splice(0, items.length, ...ordered, ...byId.values());
    await this.#notifyChanged(threadId);
  }

  /** Removes the submission a Turn is about to start; `restore` returns it if the start fails. */
  take(threadId: string, id?: string | null): TakenSubmission {
    const items = this.#queues.get(threadId) ?? [];
    const index = id == null ? 0 : items.findIndex((item) => item.id === id);
    const submission = index === -1 ? undefined : items[index];
    if (!submission) throw new ExternalQueueError(-32602, "Queued submission was not found");
    items.splice(index, 1);
    this.#prune(threadId);
    return {
      submission: publicSubmission(submission),
      sourceHostId: submission.sourceHostId,
      index,
    };
  }

  restore(threadId: string, taken: TakenSubmission): void {
    const items = this.#items(threadId);
    if (items.some((item) => item.id === taken.submission.id)) return;
    items.splice(Math.min(taken.index, items.length), 0, {
      ...taken.submission,
      sourceHostId: taken.sourceHostId,
    });
  }

  notifyChanged(threadId: string): Promise<void> {
    return this.#notifyChanged(threadId);
  }

  forget(threadId: string): void {
    this.#queues.delete(threadId);
  }

  #items(threadId: string): QueueEntry[] {
    let items = this.#queues.get(threadId);
    if (!items) {
      items = [];
      this.#queues.set(threadId, items);
    }
    return items;
  }

  #prune(threadId: string): void {
    if (this.#queues.get(threadId)?.length === 0) this.#queues.delete(threadId);
  }
}
