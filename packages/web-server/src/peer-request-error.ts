import { RpcError } from "./transport.ts";

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const OTHER_CODES = new Set([
  "ABORT_ERR",
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_ABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const ERROR_TYPES = new Set([
  "AbortError",
  "TimeoutError",
  "TypeError",
  "SyntaxError",
  "AggregateError",
  "Error",
]);
const UPLOAD_REASONS = new Set([
  "IMAGE_TOO_LARGE",
  "IMAGE_TOO_MANY_PIXELS",
  "IMAGE_TYPE_MISMATCH",
  "INVALID_IMAGE",
  "FILE_NOT_STAGED",
  "FILE_UNAVAILABLE",
]);

function safeCauseCode(code: unknown): string | undefined {
  return typeof code === "string" &&
    (TIMEOUT_CODES.has(code) || UNREACHABLE_CODES.has(code) || OTHER_CODES.has(code))
    ? code
    : undefined;
}

/** Only emit recognized types and codes, never arbitrary messages, paths or causes. */
function requestErrorDetails(error: unknown): { errorType: string; causeCode?: string } {
  const errorType = error instanceof Error && ERROR_TYPES.has(error.name) ? error.name : "Error";
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const causeCode = safeCauseCode("code" in current ? current.code : undefined);
    if (causeCode !== undefined) return { errorType, causeCode };
    current = current.cause;
  }
  return { errorType };
}

export function peerRequestError(error: unknown): RpcError {
  const details = requestErrorDetails(error);
  if (
    details.errorType === "TimeoutError" ||
    details.errorType === "AbortError" ||
    (details.causeCode !== undefined && TIMEOUT_CODES.has(details.causeCode))
  ) {
    return new RpcError("remote/timeout", "Remote peer request timed out", details);
  }
  if (details.causeCode !== undefined && UNREACHABLE_CODES.has(details.causeCode)) {
    return new RpcError("remote/offline", "Remote peer is unreachable", details);
  }
  return new RpcError("remote/request-failed", "Remote peer request failed", details);
}

export async function readPeerJson(
  response: Response,
  invalidCode: string,
  invalidMessage: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RpcError(invalidCode, invalidMessage, { errorType: "SyntaxError" });
    }
    throw peerRequestError(error);
  }
}

export function uploadErrorDetails(error: unknown) {
  if (!(error instanceof RpcError)) {
    return { errorCode: "gateway/internal", ...requestErrorDetails(error) };
  }
  const { errorType, causeCode, reason, httpStatus } = error.details as Record<string, unknown>;
  return {
    errorCode: /^[a-z][a-z0-9-]{0,31}\/[a-z][a-z0-9-]{0,47}$/u.test(error.code)
      ? error.code
      : "gateway/internal",
    errorType: typeof errorType === "string" && ERROR_TYPES.has(errorType) ? errorType : "RpcError",
    causeCode: safeCauseCode(causeCode),
    ...(typeof reason === "string" && UPLOAD_REASONS.has(reason) ? { reason } : {}),
    ...(typeof httpStatus === "number" &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 400 &&
    httpStatus <= 599
      ? { httpStatus }
      : {}),
  };
}
