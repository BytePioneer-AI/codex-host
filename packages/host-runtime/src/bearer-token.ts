import { createHmac, timingSafeEqual } from "node:crypto";
import { DELEGATION_RUNTIME_TOKEN_ENV, DELEGATION_THREAD_ID_ENV } from "./delegation-types.js";

const BOUND_TOKEN_PREFIX = "cht_";

/**
 * Whether an `Authorization` header carries exactly `Bearer <token>`. The comparison takes the
 * same time for any token of the expected length, so response timing reveals no prefix.
 */
export function matchesBearerToken(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/**
 * Derive an unforgeable per-Thread bearer token from the Runtime's base control token so an
 * external Harness process cannot omit or spoof its calling Thread identity.
 */
export function boundDelegationToken(baseToken: string, threadId: string): string {
  const encodedThread = Buffer.from(threadId, "utf8").toString("base64url");
  const mac = createHmac("sha256", baseToken).update(threadId).digest("hex");
  return `${BOUND_TOKEN_PREFIX}${encodedThread}.${mac}`;
}

export type VerifiedDelegationBearer =
  { readonly kind: "shared" } | { readonly kind: "thread"; readonly threadId: string };

export function verifyDelegationBearerToken(
  header: string | undefined,
  baseToken: string,
): VerifiedDelegationBearer | undefined {
  if (matchesBearerToken(header, baseToken)) return { kind: "shared" };
  if (!header?.startsWith(`Bearer ${BOUND_TOKEN_PREFIX}`)) return undefined;
  const raw = header.slice(`Bearer ${BOUND_TOKEN_PREFIX}`.length);
  const dot = raw.indexOf(".");
  if (dot <= 0) return undefined;
  const encodedThread = raw.slice(0, dot);
  const presentedMac = raw.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/u.test(presentedMac)) return undefined;
  let threadId: string;
  try {
    threadId = Buffer.from(encodedThread, "base64url").toString("utf8");
    if (!threadId || Buffer.from(threadId, "utf8").toString("base64url") !== encodedThread) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const expectedMac = createHmac("sha256", baseToken).update(threadId).digest("hex");
  const left = Buffer.from(presentedMac, "hex");
  const right = Buffer.from(expectedMac, "hex");
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  return { kind: "thread", threadId };
}

/**
 * Build the delegation environment for an external Harness session, binding the runtime token to
 * `threadId` when a raw base token is present.
 */
export function threadDelegationEnvironment(
  environment: NodeJS.ProcessEnv,
  threadId: string,
): NodeJS.ProcessEnv {
  const rawToken = environment[DELEGATION_RUNTIME_TOKEN_ENV];
  return {
    ...environment,
    [DELEGATION_THREAD_ID_ENV]: threadId,
    ...(rawToken && !rawToken.startsWith(BOUND_TOKEN_PREFIX)
      ? { [DELEGATION_RUNTIME_TOKEN_ENV]: boundDelegationToken(rawToken, threadId) }
      : {}),
  };
}
