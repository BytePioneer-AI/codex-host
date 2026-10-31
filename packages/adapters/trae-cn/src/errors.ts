import type { HarnessError, HarnessErrorCode } from "@codexhost/harness-adapter";

const codes = new Set<HarnessErrorCode>([
  "notInstalled",
  "unavailable",
  "authenticationRequired",
  "configurationRequired",
  "sessionNotFound",
  "sessionBusy",
  "checkpointNotFound",
  "unsupported",
  "invalidRequest",
  "invalidState",
  "protocolError",
  "processExited",
  "nativeFailure",
  "internalError",
]);

export class TraeError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
    readonly nativeCode?: number,
  ) {
    super(message);
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function responseError(value: unknown): TraeError {
  if (!record(value)) return new TraeError("protocolError", "Invalid TRAE CN bridge error");
  const code =
    typeof value.code === "string" && codes.has(value.code as HarnessErrorCode)
      ? (value.code as HarnessErrorCode)
      : "nativeFailure";
  return new TraeError(
    code,
    typeof value.message === "string" ? value.message.slice(0, 256) : "TRAE CN request failed",
    typeof value.nativeCode === "number" ? value.nativeCode : undefined,
  );
}

export function harnessError(error: unknown): HarnessError {
  const value =
    error instanceof TraeError ? error : new TraeError("nativeFailure", "TRAE CN operation failed");
  return {
    code: value.code,
    message: value.message,
    retryable: [
      "unavailable",
      "processExited",
      "authenticationRequired",
      "configurationRequired",
    ].includes(value.code),
  };
}
