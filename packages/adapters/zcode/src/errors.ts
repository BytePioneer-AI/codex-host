import {
  sanitizeDiagnosticTail,
  type HarnessError,
  type HarnessErrorCode,
  type HarnessResult,
} from "@codexhost/harness-adapter";

export class ZcodeError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
    readonly retryable = false,
    readonly rpcCode?: number,
  ) {
    super(message);
  }
}
export function failure<T = never>(
  code: HarnessErrorCode,
  message: string,
  retryable = false,
): HarnessResult<T> {
  return { ok: false, error: { code, message, retryable } };
}
export function nativeError(error: unknown): HarnessError {
  if (error instanceof ZcodeError)
    return {
      code: error.code,
      message: sanitizeDiagnosticTail(error.message),
      retryable: error.retryable,
    };
  return { code: "nativeFailure", message: "ZCode operation failed", retryable: false };
}
