import type { HarnessError, HarnessErrorCode, HarnessResult } from "@codexhost/harness-adapter";

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function requiredText(value: unknown, field: string): string {
  if (!text(value).trim()) throw new TraeError("protocolError", `Trae omitted ${field}`);
  return text(value);
}
export class TraeError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
export function errorOf(error: unknown): HarnessError {
  return error instanceof TraeError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: "nativeFailure", message: "Trae operation failed", retryable: false };
}
export function fail<T>(
  code: HarnessErrorCode,
  message: string,
  retryable = false,
): HarnessResult<T> {
  return { ok: false, error: { code, message, retryable } };
}
