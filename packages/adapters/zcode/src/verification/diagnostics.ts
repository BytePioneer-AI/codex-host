/**
 * One-line diagnostics for Start Plan verification, written to stderr (kept by the Host Runtime
 * log). Only timings, counters and SDK status codes are recorded — never proofs, tokens or URLs.
 */
export type VerificationResult =
  | "traceless_passed"
  | "interactive_passed"
  | "cancelled"
  | "expired"
  | "page_closed"
  | "error"
  | "not_required";

export interface SdkCallback {
  callback: "success" | "fail" | "onError";
  /** Milliseconds from pushing the task to the page's callback. */
  atMs: number;
  success?: boolean;
  verifyResult?: boolean;
  verifyCode?: string;
  errorCode?: string | number;
  errorName?: string;
}

/** Filled by the verifier (queue, page opening) and the page (delivery, SDK, outcome). */
export interface VerificationRecord {
  page?: number;
  pageAgeMs?: number;
  pageVerification?: number;
  queueMs?: number;
  openMs?: number;
  deliveryMs?: number;
  /** The page's SDK instance serial number; every task gets its own instance. */
  instance?: number;
  /** Milliseconds from pushing the task to `startTracelessVerification()`. */
  startedMs?: number;
  /** The SDK rejected the proof as a repeated submission (F008). */
  duplicate?: boolean;
  visibility?: string;
  rafDelayMs?: number | ">1000" | "unreported";
  sdk: SdkCallback[];
  interactiveTrigger?: "sdk" | "timeout";
  shown: boolean;
  result?: VerificationResult;
  totalMs?: number;
  /** Resolves when page-side measurements have arrived or stopped being awaited. */
  settled?: Promise<void>;
}

export function diagnose(event: string, fields: object): void {
  process.stderr.write(`[zcode-verification] ${JSON.stringify({ event, ...fields })}\n`);
}

export function writeVerification(record: VerificationRecord): void {
  // Page reports may still fill the record while it settles; snapshot only afterwards.
  void (record.settled ?? Promise.resolve()).then(() => {
    diagnose("verification", { ...record, settled: undefined });
  });
}

// Page reports are untrusted input to a log line: keep only short status tokens and numbers.
const statusToken = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : undefined;
export const pageNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function sdkCallback(body: Record<string, unknown>, since: number): SdkCallback | undefined {
  const callback = body.callback;
  if (callback !== "success" && callback !== "fail" && callback !== "onError") return undefined;
  const at = pageNumber(body.at);
  const errorCode = pageNumber(body.errorCode) ?? statusToken(body.errorCode);
  const verifyCode = statusToken(body.verifyCode);
  const errorName = statusToken(body.errorName);
  return {
    callback,
    atMs: at === undefined ? Date.now() - since : at - since,
    ...(typeof body.success === "boolean" ? { success: body.success } : {}),
    ...(typeof body.verifyResult === "boolean" ? { verifyResult: body.verifyResult } : {}),
    ...(verifyCode ? { verifyCode } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorName ? { errorName } : {}),
  };
}

export const visibilityState = (value: unknown) =>
  value === "visible" || value === "hidden" || value === "prerender" ? value : undefined;
