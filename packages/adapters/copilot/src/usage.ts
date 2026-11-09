import type { CopilotSession } from "@github/copilot-sdk";
import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type { LiveUsage } from "./usage-telemetry.js";

type Metrics = Awaited<ReturnType<CopilotSession["rpc"]["usage"]["getMetrics"]>>;

/** Native cumulative snapshots replace totals; ephemeral request receipts are never summed. */
export function usageFromMetrics(
  metrics: Pick<Metrics, "tokenDetails" | "totalNanoAiu" | "aiCreditsStatus">,
  context: HostUsage | null,
  live: LiveUsage = {},
): HostUsage | null {
  const details = metrics.tokenDetails;
  const input = details?.input?.tokenCount;
  const read = details?.cache_read?.tokenCount;
  const write = details?.cache_write?.tokenCount;
  const output = details?.output?.tokenCount;
  const nano = metrics.totalNanoAiu;
  const knownCredits =
    nano !== undefined &&
    Number.isSafeInteger(nano) &&
    nano >= 0 &&
    (metrics.aiCreditsStatus === "complete" || (metrics.aiCreditsStatus === undefined && nano > 0));
  const usage: HostUsage = {
    ...live,
    ...(knownCredits ? { totalCredits: nano / 1_000_000_000 } : {}),
    ...(context?.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: context.contextWindowTokens }),
    ...(context?.contextUsedTokens === undefined
      ? {}
      : { contextUsedTokens: context.contextUsedTokens }),
    ...(read === undefined ? {} : { cachedInputTokens: read }),
    ...(write === undefined ? {} : { cacheWriteInputTokens: write }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(input === undefined || read === undefined || write === undefined
      ? {}
      : { inputTokens: input + read + write }),
  };
  if (usage.inputTokens !== undefined && read !== undefined && read <= usage.inputTokens)
    usage.sessionCacheUsage = { inputTokens: usage.inputTokens, cachedInputTokens: read };
  return Object.keys(usage).length ? parseHostUsage(usage) : null;
}
