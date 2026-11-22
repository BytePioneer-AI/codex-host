import type {
  UpdateCheckResult,
  UpdateStartResult,
  UpdateStatusResult,
} from "@codexhost/shared-contracts";

import type { RendererUpdateClient } from "../settings/pages.js";

/** Sent with every change; browsers cannot add it from other sites. */
const CONSOLE_REQUEST_HEADER = "x-codexhost-console";

export class ConsoleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "ConsoleApiError";
  }
}

function errorMessage(payload: unknown, status: number): { message: string; code?: number } {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error: unknown }).error;
    if (typeof error === "string") return { message: error };
    if (typeof error === "object" && error !== null) {
      const record = error as { message?: unknown; code?: unknown };
      return {
        message: typeof record.message === "string" ? record.message : `HTTP ${status}`,
        ...(typeof record.code === "number" ? { code: record.code } : {}),
      };
    }
  }
  return { message: `HTTP ${status}` };
}

export async function consoleGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...(signal ? { signal } : {}) });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorMessage(payload, response.status);
    throw new ConsoleApiError(error.message, response.status, error.code);
  }
  return payload as T;
}

export async function consolePost<T>(
  path: string,
  body: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", [CONSOLE_REQUEST_HEADER]: "1" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorMessage(payload, response.status);
    throw new ConsoleApiError(error.message, response.status, error.code);
  }
  return payload as T;
}

/**
 * Request manager for the settings clients: every request goes to the running
 * Host through the console. Host errors keep their JSON-RPC code so the
 * settings pages classify them as they do inside Codex.
 */
export function hostRequestManager(): {
  sendRequest(method: string, params: unknown, options?: unknown): Promise<unknown>;
  addNotificationCallback?(
    methods: string | readonly string[],
    listener: (notification: unknown) => void,
  ): () => void;
} {
  return {
    addNotificationCallback(methods, listener) {
      const requested = typeof methods === "string" ? [methods] : methods;
      if (!requested.includes("codexhost/harness/display-settings/changed")) return () => {};
      const source = new EventSource("/api/host/display-events");
      source.onmessage = () =>
        listener({ method: "codexhost/harness/display-settings/changed", params: {} });
      return () => source.close();
    },
    async sendRequest(method, params, options) {
      if (method === "codexhost/harness/display-settings/capabilities") {
        try {
          const transport = await consoleGet<{ events: boolean }>("/api/host/display-capabilities");
          if (!transport.events) return { events: false };
        } catch (error) {
          if (error instanceof ConsoleApiError && error.status === 404) return { events: false };
          throw error;
        }
      }
      const signal = options instanceof AbortSignal ? options : undefined;
      const reply = await consolePost<{
        result?: unknown;
        error?: { code: number; message: string };
      }>("/api/host/request", { method, params }, signal);
      if (reply.error) {
        throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
      }
      return reply.result;
    },
  };
}

/** Updates go through the console, which uses the running Host when there is one. */
export function consoleUpdateClient(): RendererUpdateClient {
  return {
    checkUpdate: () => consolePost<UpdateCheckResult | null>("/api/update/check"),
    startUpdate: () => consolePost<UpdateStartResult>("/api/update/start"),
    readUpdateStatus: () => consoleGet<UpdateStatusResult>("/api/update/status"),
  };
}
