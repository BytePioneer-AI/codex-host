import type { JsonValue } from "@codexhost/protocol-core";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Live Harness events only: retains ancestry while Threads are open, never event or
 * conversation content.
 */
export class ThreadActivity {
  readonly #parents = new Map<string, string>();
  /** Closed Threads kept because an open descendant still reports through them. */
  readonly #closed = new Set<string>();
  readonly #listeners = new Set<(threadIds: readonly string[]) => void>();

  /** Threads whose ancestry is still retained. */
  get size(): number {
    return new Set([...this.#parents.keys(), ...this.#closed]).size;
  }

  subscribe(listener: (threadIds: readonly string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  note(threadId: string, parentThreadId?: string): void {
    this.#closed.delete(threadId);
    const previous = this.#parents.get(threadId);
    if (parentThreadId && parentThreadId !== threadId && parentThreadId !== previous) {
      this.#parents.set(threadId, parentThreadId);
      this.#prune(previous);
    }
    const active = new Set<string>();
    let current: string | undefined = threadId;
    while (current && !active.has(current)) {
      active.add(current);
      current = this.#parents.get(current);
    }
    const threadIds = [...active];
    for (const listener of this.#listeners) listener(threadIds);
  }

  /**
   * Native ancestry is learned only when a Thread starts, so a closed Thread keeps its
   * link until every descendant reporting through it has closed too.
   */
  close(threadId: string): void {
    this.#closed.add(threadId);
    this.#prune(threadId);
  }

  /** Only for Threads whose links are noted again with every event they report. */
  forget(threadId: string): void {
    const parent = this.#parents.get(threadId);
    this.#parents.delete(threadId);
    this.#closed.delete(threadId);
    for (const [child, childParent] of this.#parents) {
      if (childParent === threadId) this.#parents.delete(child);
    }
    this.#prune(parent);
  }

  clear(): void {
    this.#parents.clear();
    this.#closed.clear();
  }

  observeOfficial(value: JsonValue): void {
    // Replies to Host polling are not Harness activity.
    if (!record(value) || typeof value.method !== "string" || !record(value.params)) return;
    const params = value.params;
    const thread = record(params.thread) ? params.thread : undefined;
    const threadId = typeof params.threadId === "string" ? params.threadId : thread?.id;
    if (typeof threadId !== "string" || !threadId) return;
    const source = record(thread?.source) ? thread.source : undefined;
    const subagent = record(source?.subAgent) ? source.subAgent : undefined;
    const spawn = record(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
    const parent = typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id : undefined;
    this.note(threadId, parent);
    if (value.method === "thread/closed") {
      this.close(threadId);
      return;
    }
    const item = record(params.item) ? params.item : undefined;
    if (
      item?.type === "collabAgentToolCall" &&
      item.tool === "spawnAgent" &&
      Array.isArray(item.receiverThreadIds)
    ) {
      for (const child of item.receiverThreadIds) {
        if (typeof child === "string" && child) this.note(child, threadId);
      }
    }
  }

  /** Drops closed Threads upward until one still has a retained child or is open. */
  #prune(threadId: string | undefined): void {
    let current = threadId;
    while (current && this.#closed.has(current) && !this.#hasChildren(current)) {
      this.#closed.delete(current);
      const parent = this.#parents.get(current);
      this.#parents.delete(current);
      current = parent;
    }
  }

  #hasChildren(threadId: string): boolean {
    for (const parent of this.#parents.values()) if (parent === threadId) return true;
    return false;
  }
}
