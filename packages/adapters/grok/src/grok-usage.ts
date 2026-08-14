import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function usageFromPrompt(response: PromptResponse): HostUsage | null {
  const usage = response.usage;
  if (!usage) return null;
  try {
    return parseHostUsage({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      ...(usage.thoughtTokens !== undefined && usage.thoughtTokens !== null
        ? { reasoningOutputTokens: usage.thoughtTokens }
        : {}),
      ...(usage.cachedReadTokens !== undefined && usage.cachedReadTokens !== null
        ? { cachedInputTokens: usage.cachedReadTokens }
        : {}),
      ...(usage.cachedWriteTokens !== undefined && usage.cachedWriteTokens !== null
        ? { cacheWriteInputTokens: usage.cachedWriteTokens }
        : {}),
    });
  } catch {
    return null;
  }
}

export function usageFromUpdate(
  update: SessionUpdate | undefined,
  metadata: Record<string, unknown> | undefined,
  contextWindowTokens: number | undefined,
): HostUsage | null {
  try {
    if (update?.sessionUpdate === "usage_update") {
      const cost = isRecord(update.cost) ? update.cost : null;
      return parseHostUsage({
        contextUsedTokens: update.used,
        contextWindowTokens: update.size,
        ...(cost?.currency === "USD" && typeof cost.amount === "number"
          ? { totalCostUsd: cost.amount }
          : {}),
      });
    }
    const totalTokens = metadata?.totalTokens;
    if (
      typeof totalTokens !== "number" ||
      !Number.isSafeInteger(totalTokens) ||
      totalTokens < 0 ||
      contextWindowTokens === undefined
    ) {
      return null;
    }
    return parseHostUsage({
      contextUsedTokens: totalTokens,
      contextWindowTokens,
      totalTokens,
    });
  } catch {
    return null;
  }
}
