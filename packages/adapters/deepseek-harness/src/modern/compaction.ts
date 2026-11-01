import type { HostItemOutcome, HostUsage } from "@codexhost/harness-adapter";

import { isRecord } from "../projection.js";
import type { ModernProjectionRow } from "./control-store.js";
import { redactModernCredential } from "./wire.js";

export const MODERN_CONTEXT_PRESSURE_KEY = "contextPressure";

/** DSH reports automatic failure on the compaction, not necessarily on its Turn. */
export function modernCompactionOutcome(data: Readonly<Record<string, unknown>>): HostItemOutcome {
  return typeof data.error === "string"
    ? {
        status: "failed",
        error: {
          code: "nativeFailure",
          message: redactModernCredential(data.error),
          retryable: true,
        },
      }
    : { status: "succeeded" };
}

/** Prefer DSH's replacement-aware occupancy; never subtract from billing counters. */
export function withModernContextPressure(
  usage: HostUsage | null,
  row: ModernProjectionRow | undefined,
): HostUsage | null {
  if (!row || !isRecord(row.value)) return usage;
  const value = row.value;
  const tokens = value.projectedTokens ?? value.pressureTokens;
  const window = value.contextWindow;
  if (
    typeof tokens !== "number" ||
    !Number.isSafeInteger(tokens) ||
    tokens < 0 ||
    typeof window !== "number" ||
    !Number.isSafeInteger(window) ||
    window <= 0
  )
    return usage;
  return { ...usage, contextUsedTokens: tokens, contextWindowTokens: window };
}
