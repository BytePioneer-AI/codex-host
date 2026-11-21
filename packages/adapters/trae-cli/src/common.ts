import {
  sanitizeDiagnosticTail,
  type HarnessError,
  type HarnessErrorCode,
} from "@codexhost/harness-adapter";
import { harnessIdSchema } from "@codexhost/shared-contracts";

export const TRAE_CLI_ID = harnessIdSchema.parse("trae-cli");
export class TraeCliError extends Error {
  constructor(
    readonly kind: HarnessErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export function traeError(error: unknown): HarnessError {
  const message = sanitizeDiagnosticTail(
    error instanceof Error ? error.message : "TRAE CLI request failed",
  );
  const kind =
    error instanceof TraeCliError
      ? error.kind
      : /auth|not logged in|login|unauthorized/iu.test(message)
        ? "authenticationRequired"
        : /not installed|ENOENT/iu.test(message)
          ? "notInstalled"
          : /session.*not found/iu.test(message)
            ? "sessionNotFound"
            : "protocolError";
  return { code: kind, message, retryable: kind === "sessionBusy" };
}
export const rejected = (code: HarnessErrorCode, message: string) => ({
  ok: false as const,
  error: { code, message, retryable: code === "sessionBusy" },
});
