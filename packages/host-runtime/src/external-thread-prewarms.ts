import type { JsonRpcRequest } from "@codexhost/shared-contracts";
import type { ExternalThread } from "./external-thread-runtime.js";

const ADOPTING_METHODS = new Set([
  "turn/start",
  "turn/steer",
  "thread/resume",
  "thread/fork",
  "thread/revert",
  "thread/rollback",
  "thread/delete",
  "codexhost/thread/fork",
  "codexhost/thread/command/execute",
  "codexhost/thread/model/select",
  "codexhost/thread/thinking/select",
  "codexhost/thread/permission-mode/select",
]);

/** Host-owned draft leases. Adoption and discard run on the same per-Thread request queue. */
export class ExternalThreadPrewarms {
  readonly #threads = new Map<string, ExternalThread>();

  register(thread: ExternalThread): void {
    this.#threads.set(thread.id, thread);
  }

  observe(request: JsonRpcRequest): Error | null {
    if (!ADOPTING_METHODS.has(request.method)) return null;
    const params = request.params;
    if (
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      typeof params.threadId === "string"
    ) {
      const thread = this.#threads.get(params.threadId);
      if (thread?.persistenceError) return thread.persistenceError;
      this.#threads.delete(params.threadId);
    }
    return null;
  }

  clear(): void {
    this.#threads.clear();
  }

  async discard(
    threadId: string,
    options: {
      get(id: string): ExternalThread | undefined;
      remove(thread: ExternalThread): Promise<void>;
    },
  ): Promise<boolean> {
    const thread = this.#threads.get(threadId);
    if (!thread) return false;
    if (options.get(threadId) !== thread) {
      this.#threads.delete(threadId);
      return false;
    }
    // Native work wins even if it originated outside the usual request path.
    if (
      thread.running ||
      thread.activeTurnId ||
      thread.turns.length ||
      thread.record.turnMappings.length ||
      thread.session.hasBackgroundWork?.()
    ) {
      this.#threads.delete(threadId);
      return false;
    }
    try {
      await thread.session.close();
      await thread.outputTask;
      await options.remove(thread);
      this.#threads.delete(threadId);
      return true;
    } catch (error) {
      // Never turn an uncertain close into permission to start another native writer.
      thread.persistenceError = error instanceof Error ? error : new Error(String(error));
      thread.stateObserver.fault(thread.persistenceError);
      throw error;
    }
  }
}
