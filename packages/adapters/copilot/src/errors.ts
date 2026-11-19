import {
  sanitizeDiagnosticTail,
  type HarnessError,
  type HarnessErrorCode,
  type HarnessResult,
} from "@codexhost/harness-adapter";
import { CopilotLaunchError } from "./command.js";
import { CopilotReferenceError } from "./refs.js";

export class CopilotOperationError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
    readonly diagnostic?: string,
    readonly retryable?: boolean,
    readonly stage?: string,
  ) {
    super(message);
  }
}

export function failure<T>(code: HarnessErrorCode, message: string): HarnessResult<T> {
  return { ok: false, error: { code, message, retryable: code === "sessionBusy" } };
}

/** Only the message is considered; SDK stderr, stack and RPC payloads are never copied. */
function diagnosticMessage(message: string, stage?: string): string {
  if (stage === "interaction" || /\b(?:answers?|elicitation|user.?input)\b/iu.test(message))
    return "Interaction details omitted.";
  const firstLine = message.split(/[\r\n]/u)[0] ?? "";
  if (/^\[CLI subprocess\]/u.test(firstLine)) return "Native process details omitted.";
  return sanitizeDiagnosticTail(
    firstLine
      .replace(
        /\b(?:stderr|headers|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=].*$/giu,
        "[sensitive details omitted]",
      )
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[redacted]")
      .replace(
        /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
        "[redacted]",
      )
      .replace(
        /([\w-]*(?:token|password|secret|api[_-]?key|credential)[\w-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;]+)/giu,
        "$1[redacted]",
      )
      .replace(/(https?:\/\/)[^\s/@]+@/giu, "$1[redacted]@")
      .replace(/([?&][^\s=&#]+)=([^\s&#]+)/gu, "$1=[redacted]"),
  ).slice(0, 2000);
}

export function nativeError(error: unknown, stage?: string): HarnessError {
  const fields =
    error !== null && typeof error === "object"
      ? (error as { message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown })
      : {};
  const message =
    typeof fields.message === "string" ? fields.message : typeof error === "string" ? error : "";
  const nativeCode =
    typeof fields.code === "number" ||
    (typeof fields.code === "string" && /^[A-Z_0-9-]{1,40}$/u.test(fields.code))
      ? fields.code
      : undefined;
  const status = fields.statusCode ?? fields.status;
  const context = error instanceof CopilotOperationError ? (error.stage ?? stage) : stage;
  const detail = diagnosticMessage(
    error instanceof CopilotOperationError ? (error.diagnostic ?? message) : message,
    context,
  );
  const extra = {
    ...(context ? { stage: context } : {}),
    ...(detail || nativeCode !== undefined
      ? {
          diagnostic: [detail, nativeCode !== undefined ? `Native code: ${nativeCode}` : ""]
            .filter(Boolean)
            .join("; "),
        }
      : {}),
  };
  const result = (code: HarnessErrorCode, friendly: string, retryable = false): HarnessError => ({
    code,
    message: friendly,
    retryable,
    ...extra,
  });
  if (error instanceof CopilotOperationError)
    return result(
      error.code,
      context === "interaction"
        ? "Copilot could not complete the interaction."
        : diagnosticMessage(error.message),
      error.retryable ?? error.code === "sessionBusy",
    );
  if (error instanceof CopilotReferenceError)
    return result("invalidRequest", diagnosticMessage(error.message));
  if (error instanceof CopilotLaunchError)
    return result(error.code, diagnosticMessage(error.message));
  if (/session.*(?:not found|does not exist)|(?:not found|does not exist).*session/iu.test(message))
    return result("sessionNotFound", "Copilot native session was not found.");
  if (/protocol version mismatch/iu.test(message))
    return result("protocolError", "The installed Copilot CLI is incompatible with this SDK.");
  if (
    /(?:corrupt|damaged|invalid|parse|recover).*(?:history|transcript|journal|session file)|(?:history|transcript|journal|session file).*(?:corrupt|damaged|invalid|parse|recover)/iu.test(
      message,
    )
  ) {
    const problem = result(
      "protocolError",
      "Copilot could not restore the complete native history.",
    );
    problem.diagnostic = [
      "Native history is corrupt or unreadable.",
      ...new Set(message.match(/\b(?:line|column)\s+\d+/giu) ?? []),
      ...(nativeCode !== undefined ? [`Native code: ${nativeCode}`] : []),
    ].join("; ");
    return problem;
  }
  if (
    status === 401 ||
    /unauthenticated|unauthorized|authentication.*(?:failed|rejected|required)|\bHTTP\s*401\b/iu.test(
      message,
    )
  )
    return result(
      "authenticationRequired",
      "Copilot authentication was rejected. Check the target Host's native CLI login.",
    );
  if (nativeCode === "ETIMEDOUT" || /timed?\s*out|\btimeout\b/iu.test(message))
    return result(
      "nativeFailure",
      "Copilot's native operation timed out. Retry the operation.",
      true,
    );
  if (
    nativeCode === "EACCES" ||
    nativeCode === "EPERM" ||
    status === 403 ||
    /permission.*(?:denied|rejected)|access denied|\bforbidden\b/iu.test(message)
  )
    return result(
      "nativeFailure",
      "Copilot denied the operation. Check native permissions and policy.",
    );
  if (
    /model.*(?:not supported|unavailable|not found|rejected)|(?:invalid|unknown|unsupported) model|reasoning effort.*(?:not supported|invalid)/iu.test(
      message,
    )
  )
    return result(
      "configurationRequired",
      "Copilot rejected the requested model configuration. Choose an available option.",
    );
  if (
    /client not connected|connection.*(?:closed|exited)|session.*disconnected|CLI process exited/iu.test(
      message,
    )
  )
    return result("processExited", "Copilot's native connection ended.", true);
  return result(
    "nativeFailure",
    "Copilot could not complete the native operation. Check the diagnostic and retry.",
    true,
  );
}

export function sessionError(data: { statusCode?: number; message?: string }): HarnessError {
  return nativeError(
    { message: data.message ?? "Copilot reported a native failure.", statusCode: data.statusCode },
    "turn.execute",
  );
}

export async function bounded<T>(promise: Promise<T>, milliseconds = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CopilotOperationError(
                "nativeFailure",
                "Copilot's native operation timed out.",
                `Timeout after ${milliseconds} ms`,
                true,
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
