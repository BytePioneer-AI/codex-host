import type { HostItemOutcome, TurnOutcome } from "@codexhost/harness-adapter";

/** ACP /compress returns human-readable results and end_turn even on failure. */
export function hermesCompactionOutcome(outcome: TurnOutcome, nativeText: string): HostItemOutcome {
  if (outcome.status !== "succeeded") return outcome;
  const text = nativeText.trim();
  // This confirmation is emitted only after history replacement + native save.
  if (/^Context compressed: \d+ -> \d+ messages\n~[\d,]+ -> ~[\d,]+ tokens$/u.test(text)) {
    return { status: "succeeded" };
  }
  if (
    /^(?:Compression failed:|Error executing \/compress:|Context compression not available)/u.test(
      text,
    )
  ) {
    return { status: "failed", error: { code: "nativeFailure", message: text, retryable: false } };
  }
  // Empty history and other no-op/unsupported-version responses must not look
  // like a successful compaction. Preserve their native explanation verbatim.
  return { status: "cancelled", reason: text || "Hermes did not confirm context compression" };
}
