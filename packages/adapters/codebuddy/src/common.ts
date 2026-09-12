import {
  sanitizeDiagnosticTail,
  type HarnessError,
  type HarnessErrorCode,
  type HarnessResult,
} from "@codexhost/harness-adapter";
import { harnessIdSchema } from "@codexhost/shared-contracts";

export const CODEBUDDY_ID = harnessIdSchema.parse("codebuddy");
export const OUTPUT_LIMIT = 64_000;
export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record) : [];
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

export class CodeBuddyError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function nativeError(error: unknown): HarnessError {
  const diagnostic = sanitizeDiagnosticTail(error instanceof Error ? error.message : String(error));
  const nativeCode = record(error).code;
  const code =
    error instanceof CodeBuddyError
      ? error.code
      : nativeCode === -32000 ||
          /authentication required|not logged in|unauthenticated/iu.test(diagnostic)
        ? "authenticationRequired"
        : nativeCode === "ENOENT"
          ? "notInstalled"
          : /session.*not found/iu.test(diagnostic)
            ? "sessionNotFound"
            : "nativeFailure";
  return {
    code,
    message: `CodeBuddy: ${diagnostic || "native operation failed"}`,
    retryable: ["sessionBusy", "unavailable"].includes(code),
  };
}

export function failure<T>(code: HarnessErrorCode, message: string): HarnessResult<T> {
  return { ok: false, error: nativeError(new CodeBuddyError(code, message)) };
}

export async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
  onTimeout?: (error: CodeBuddyError) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new CodeBuddyError("unavailable", `${label} timed out`);
          try {
            onTimeout?.(error);
          } finally {
            reject(error);
          }
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
