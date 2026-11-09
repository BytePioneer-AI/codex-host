import type { HarnessSession } from "@codexhost/harness-adapter";

const RELEASE_TIMEOUT_MS = 60_000;

export class ExternalSessionReleaseError extends Error {
  constructor(cause: unknown) {
    super(
      "External Session shutdown could not be confirmed. Retry to confirm release; recovery is blocked until the old Session closes and its output drains. If the Harness cannot retry shutdown, stop residual processes and restart Codex Desktop.",
      { cause },
    );
    this.name = "ExternalSessionReleaseError";
  }
}

/** Host lifecycle ordering, not a lock on native work or the output consumer. */
export class ExternalThreadLifecycle {
  readonly #pending = new Map<string, Promise<void>>();
  readonly #closing = new WeakMap<HarnessSession, Promise<void>>();
  readonly #releasing = new Map<string, { session: HarnessSession; output: Promise<void> }>();

  busy(id: string): boolean {
    return this.#pending.has(id) || this.#releasing.has(id);
  }

  pending(): Array<[string, Promise<void>]> {
    return [...this.#pending];
  }

  run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(id) ?? Promise.resolve();
    // Admission is synchronous; even the first operation starts only after its barrier exists.
    const task = previous.then(async () => {
      // A failed release blocks the lane, including cleanup of an unsuccessful restore.
      const releasing = this.#releasing.get(id);
      if (releasing) await this.release(id, releasing.session, releasing.output);
      return operation();
    });
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.set(id, settled);
    void settled.then(() => {
      if (this.#pending.get(id) === settled) this.#pending.delete(id);
    });
    return task;
  }

  /** Call inside the Thread's lifecycle operation. A timeout never cancels the owned close. */
  async release(id: string, session: HarnessSession, output: Promise<void>): Promise<void> {
    // Serialized operations stop at the first failed release: only one blocker per Thread.
    this.#releasing.set(id, { session, output });
    let closing = this.#closing.get(session);
    if (!closing) {
      closing = Promise.resolve().then(() => session.close());
      this.#closing.set(session, closing);
      const attempt = closing;
      void closing.catch(() => {
        // A rejected close may be retried, but never while an earlier close is still pending.
        // Adapters with a cached terminal failure will keep rejecting: that is not release proof.
        if (this.#closing.get(session) === attempt) this.#closing.delete(session);
      });
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        closing.then(() => output),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Session shutdown timed out")),
            RELEASE_TIMEOUT_MS,
          );
          timeout.unref();
        }),
      ]);
      // Only this bounded waiter clears the blocker. Late close completion does not mutate
      // the Runtime or publish a replacement; a later request must recheck the current owner.
      this.#releasing.delete(id);
    } catch (error) {
      throw new ExternalSessionReleaseError(error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.all(this.#pending.values());
  }
}
