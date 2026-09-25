import type { DiagnosticLog } from "./diagnostic-log.js";

type JsonRpcId = string | number;

interface PendingDesktopRequest {
  method: string;
  threadId: string;
  startedAtMs: number;
}

/** Requests forwarded to the official app-server are forgotten, so this bound is a safety net. */
const PENDING_REQUESTS_MAX = 1_024;

// Log labels only: unknown protocol methods must not become free-text log content.
const LOGGED_METHODS = new Set([
  "thread/archive",
  "thread/delete",
  "thread/fork",
  "thread/items/list",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/resume",
  "thread/revert",
  "thread/rollback",
  "thread/turns/list",
  "thread/unarchive",
  "thread/unsubscribe",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "codexhost/thread/fork",
  "codexhost/thread/inspect",
  "codexhost/thread/usage/inspect",
  "codexhost/thread/model/select",
  "codexhost/thread/thinking/select",
  "codexhost/thread/permission-mode/select",
  "codexhost/thread/commands/inspect",
  "codexhost/thread/command/execute",
]);

/**
 * Correlates Host-authored Desktop responses with their Thread-scoped requests. Only known
 * methods, numeric IDs, JSON-RPC error codes, and timing are persisted. String IDs remain
 * in memory for correlation; request params and free-text errors never enter the log.
 */
export class DesktopRequestLog {
  readonly #pending = new Map<JsonRpcId, PendingDesktopRequest>();

  constructor(
    private readonly log: DiagnosticLog,
    private readonly now: () => number = Date.now,
  ) {}

  begin(id: JsonRpcId, method: string, threadId: string): void {
    if (this.#pending.size >= PENDING_REQUESTS_MAX) {
      const oldest = this.#pending.keys().next();
      if (!oldest.done) this.#pending.delete(oldest.value);
    }
    this.#pending.set(id, {
      method: LOGGED_METHODS.has(method) ? method : "unknown",
      threadId,
      startedAtMs: this.now(),
    });
  }

  forget(id: JsonRpcId): void {
    this.#pending.delete(id);
  }

  /** Observes every JSON value the Host writes to Desktop. */
  observe(value: unknown): void {
    if (!isRecord(value) || "method" in value) return;
    const id = value.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    const thread = this.log.knownThread(pending.threadId);
    const durationMs = this.now() - pending.startedAtMs;
    const error = isRecord(value.error) ? value.error : null;
    if (!error) {
      thread?.write("debug", "desktop.request.completed", {
        method: pending.method,
        requestId: typeof id === "number" ? id : undefined,
        durationMs,
      });
      return;
    }
    const fields = {
      method: pending.method,
      requestId: typeof id === "number" ? id : undefined,
      durationMs,
      code: typeof error.code === "number" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message : undefined,
    };
    if (thread) thread.write("warn", "desktop.request.failed", fields);
    else
      this.log.runtime("warn", "desktop.request.failed", { threadId: pending.threadId, ...fields });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
