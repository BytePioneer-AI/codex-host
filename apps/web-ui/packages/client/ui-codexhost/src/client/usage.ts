/** Browser-safe projection of the public CodexHost Thread Usage contract. */

export interface HostThreadUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  readonly outputTokensPerSecond?: number;
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

export interface HostAccountProductUsage {
  readonly product: string;
  readonly periodType?: HostAccountCredits["periodType"];
  readonly scope?: { readonly id: string; readonly label: string };
  readonly used?: number;
  readonly limit?: number;
  readonly unit?: string;
  readonly usagePercent: number;
  readonly resetsAt?: string;
}

export interface HostAccountCredits {
  readonly used?: number;
  readonly limit?: number;
  readonly unit?: string;
  readonly label?: string;
  readonly scope?: { readonly id: string; readonly label: string };
  readonly usedPercent: number;
  readonly resetsAt?: string;
  readonly periodType: "weekly" | "monthly" | "five_hour" | "seven_day" | "unknown";
  readonly productUsage?: readonly HostAccountProductUsage[];
  readonly resetCredits?: {
    readonly availableCount: number;
    readonly nextExpiresAt?: string;
    readonly expiresAt?: readonly string[];
  };
}

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
