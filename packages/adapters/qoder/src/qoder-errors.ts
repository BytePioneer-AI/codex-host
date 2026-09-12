import type { HarnessError } from "@codexhost/harness-adapter";
import type { SDKResultMessage } from "./qoder-sdk-types.js";

export function mapQoderResultError(result: SDKResultMessage): HarnessError {
  const errorCode = result.error_code;
  const message =
    (result.errors && result.errors.length > 0 ? result.errors.join("; ") : undefined) ||
    `Qoder execution error (code ${errorCode ?? result.subtype})`;

  if (errorCode === 105) {
    return {
      code: "authenticationRequired",
      message: "Qoder authentication expired or required",
      retryable: false,
    };
  }

  if (errorCode === 430) {
    return {
      code: "unsupported",
      message: `Qoder capability unsupported: ${message}`,
      retryable: false,
    };
  }

  if (errorCode === 47902) {
    return {
      code: "invalidState",
      message: `Qoder turn limit reached: ${message}`,
      retryable: false,
    };
  }

  if (errorCode === 500 || errorCode === 10408 || errorCode === 10500) {
    return {
      code: "nativeFailure",
      message,
      retryable: true,
      diagnostic: `error_code: ${errorCode}`,
    };
  }

  return {
    code: "nativeFailure",
    message,
    retryable: false,
    ...(errorCode !== undefined ? { diagnostic: `error_code: ${errorCode}` } : {}),
  };
}

export function mapQoderExitCode(exitCode: number, stderrTail?: string): HarnessError {
  const base = stderrTail ? { stderrTail } : {};
  switch (exitCode) {
    case 41:
      return {
        code: "authenticationRequired",
        message: "Qoder CLI authentication required (exit code 41)",
        retryable: false,
        ...base,
      };
    case 42:
      return {
        code: "invalidRequest",
        message: "Qoder CLI invalid request parameters (exit code 42)",
        retryable: false,
        ...base,
      };
    case 44:
    case 54:
      return {
        code: "nativeFailure",
        message: `Qoder tool or sandbox execution failure (exit code ${exitCode})`,
        retryable: false,
        ...base,
      };
    case 52:
      return {
        code: "nativeFailure",
        message: "Qoder configuration error (exit code 52)",
        retryable: false,
        ...base,
      };
    case 53:
      return {
        code: "invalidState",
        message: "Qoder session turn limit reached (exit code 53)",
        retryable: false,
        ...base,
      };
    default:
      return {
        code: "nativeFailure",
        message: `Qoder CLI exited with code ${exitCode}`,
        retryable: false,
        ...base,
      };
  }
}

export function mapQoderException(error: unknown): HarnessError {
  if (error && typeof error === "object") {
    const candidate = error as { code?: string; exitCode?: number; message?: string };
    if (typeof candidate.exitCode === "number") {
      return mapQoderExitCode(candidate.exitCode, candidate.message);
    }
    const message = candidate.message || String(error);
    const lower = message.toLowerCase();

    if (lower.includes("not installed") || lower.includes("qoder_not_found")) {
      return {
        code: "notInstalled",
        message,
        retryable: false,
      };
    }
    if (lower.includes("auth") || lower.includes("unauthorized") || lower.includes("token")) {
      return {
        code: "authenticationRequired",
        message,
        retryable: false,
      };
    }
    if (lower.includes("session not found") || lower.includes("nosession")) {
      return {
        code: "sessionNotFound",
        message,
        retryable: false,
      };
    }
    if (lower.includes("unsupported")) {
      return {
        code: "unsupported",
        message,
        retryable: false,
      };
    }
    if (lower.includes("protocol") || lower.includes("version mismatch")) {
      return {
        code: "protocolError",
        message,
        retryable: false,
      };
    }
    return {
      code: "nativeFailure",
      message,
      retryable: false,
    };
  }
  return {
    code: "nativeFailure",
    message: String(error),
    retryable: false,
  };
}
