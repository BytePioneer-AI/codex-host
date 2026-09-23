import type { DiagnosticLog } from "./diagnostic-log.js";

type JsonRpcId = string | number;

interface PendingDesktopRequest {
  method: string;
  threadId: string;
  startedAtMs: number;
}

/** Requests forwarded to the official app-server are forgotten, so this bound is a safety net. */
const PENDING_REQUESTS_MAX = 1_024;

/**
 * Correlates Host-authored Desktop responses with their Thread-scoped requests. Only the method,
 * JSON-RPC error code, and error message are recorded; request params never are.
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
    this.#pending.set(id, { method, threadId, startedAtMs: this.now() });
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
        requestId: id,
        durationMs,
      });
      return;
    }
    const fields = {
      method: pending.method,
      requestId: id,
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
