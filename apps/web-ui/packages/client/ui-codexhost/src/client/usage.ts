/** Browser-safe projection of the public CodexHost Thread Usage contract. */

import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

export interface HostThreadUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  readonly outputTokensPerSecond?: number;
  readonly sessionOutputTokensPerSecond?: number;
  readonly apiOutputTokensPerSecond?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
  readonly totalCostUsd?: number;
  readonly totalCredits?: number;
  readonly contextUsagePercent?: number;
  readonly cacheHitRatePercent?: number;
  readonly contextWindowTokens?: number;
  readonly contextUsedTokens?: number;
  readonly planFiveHourUsedPercent?: number;
  readonly planFiveHourResetsAtUnix?: number;
  readonly planSevenDayUsedPercent?: number;
  readonly planSevenDayResetsAtUnix?: number;
  readonly sessionCacheHitRatePercent?: number;
  readonly timeToFirstOutputMs?: number;
  readonly costSource?: "publicPrice" | "native";
  readonly unpricedModels?: readonly string[];
}

export type HostAccountCredits = AccountCreditsSnapshot;
export type HostAccountProductUsage = NonNullable<AccountCreditsSnapshot["productUsage"]>[number];

export interface CodexHostUsageProjection {
  readonly usage: HostThreadUsage | null;
  readonly accountCredits?: HostAccountCredits;
}

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    /** Confirmed Host usage and optional account quota for this exact Thread. */
    codexhostUsage: CodexHostUsageProjection | null;
  }
}
