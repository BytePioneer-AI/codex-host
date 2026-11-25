/** Orders request routing within a Thread, without serializing unrelated requests or active Turns. */
export class DesktopRequestQueue {
  readonly #threads = new Map<string, Promise<void>>();
  readonly #pending = new Set<Promise<void>>();

  run(threadId: string | undefined, operation: () => Promise<void>): Promise<void> {
    const previous = threadId === undefined ? undefined : this.#threads.get(threadId);
    const task = (previous ?? Promise.resolve()).then(operation);
    // A failed request must not poison the Thread's queue. The caller still receives its error.
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.add(settled);
    if (threadId !== undefined) this.#threads.set(threadId, settled);
    void settled.then(() => {
      this.#pending.delete(settled);
      if (threadId !== undefined && this.#threads.get(threadId) === settled) {
        this.#threads.delete(threadId);
      }
    });
    return task;
  }

  /** Call after admission stops, before taking the Session snapshot for shutdown. */
  async drain(): Promise<void> {
    await Promise.all(this.#pending);
  }
}
