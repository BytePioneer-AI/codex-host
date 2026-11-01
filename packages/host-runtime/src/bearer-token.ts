import { timingSafeEqual } from "node:crypto";

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
