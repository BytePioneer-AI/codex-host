import {
  sanitizeDiagnosticTail,
  type HarnessError,
  type HarnessErrorCode,
  type HarnessResult,
  type HarnessSessionCapabilities,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  type HarnessCommandCatalog,
  type HarnessId,
} from "@codexhost/shared-contracts";

export const CODEBUDDY_ID = harnessIdSchema.parse("codebuddy");
export interface CodeBuddyRuntimeProfile {
  readonly harnessId: HarnessId;
  readonly displayName: string;
  readonly interactionIdPrefix: string;
  /** The first configured value is the native history root. */
  readonly configDirectoryEnvironmentVariables: readonly string[];
  readonly defaultConfigDirectoryName: string;
  /** Native project directory encoding, applied to the canonical working directory. */
  readonly projectDirectoryName?: (canonicalCwd: string) => string;
  /** Commands that are safe to advertise before a Native Session reports its live catalog. */
  readonly staticCommandCatalog?: HarnessCommandCatalog;
  /** Opt in to the native available_commands_update and slash-command execution contract. */
  readonly nativeCommands?: boolean;
  /** Native history operations independently verified for this product profile. */
  readonly historyCapabilities?: HarnessSessionCapabilities["history"];
  /** The product file is authoritative even when ACP omits its Models from the option rows. */
  readonly allowUnlistedModelSelection?: boolean;
}

export const CODEBUDDY_RUNTIME_PROFILE: CodeBuddyRuntimeProfile = {
  harnessId: CODEBUDDY_ID,
  displayName: "CodeBuddy",
  interactionIdPrefix: "codebuddy",
  configDirectoryEnvironmentVariables: ["CODEBUDDY_CONFIG_DIR"],
  defaultConfigDirectoryName: ".codebuddy",
};
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

export function nativeError(
  error: unknown,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): HarnessError {
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
    message: `${profile.displayName}: ${diagnostic || "native operation failed"}`,
    retryable: ["sessionBusy", "unavailable"].includes(code),
  };
}

export function failure<T>(
  code: HarnessErrorCode,
  message: string,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): HarnessResult<T> {
  return { ok: false, error: nativeError(new CodeBuddyError(code, message), profile) };
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
