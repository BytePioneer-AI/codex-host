import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";

import type { CodeBuddyModelUsage, CodeBuddyTurnResult } from "./stream-protocol.js";

function optionalCount(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function primaryModelUsage(
  modelUsage: Record<string, CodeBuddyModelUsage>,
  modelId: string | null,
): CodeBuddyModelUsage | null {
  if (modelId && modelUsage[modelId]) return modelUsage[modelId] ?? null;
  for (const entry of Object.values(modelUsage)) {
    if (entry) return entry;
  }
  return null;
}

/**
 * Maps a terminal `result` frame to the public HostUsage. Returns `null` when
 * the frame carries no reliable usage data.
 */
export function usageFromTurnResult(
  result: CodeBuddyTurnResult,
  modelId: string | null,
): HostUsage | null {
  const usage = result.usage;
  const model = primaryModelUsage(result.modelUsage, modelId);
  const hasValidCost =
    result.totalCostUsd !== null &&
    Number.isFinite(result.totalCostUsd) &&
    result.totalCostUsd >= 0;
  if (!usage && !model && !hasValidCost) return null;
  const candidate: HostUsage = {};
  if (usage) {
    const inputTokens = optionalCount(usage.input_tokens);
    const cachedInputTokens = optionalCount(usage.cache_read_input_tokens ?? undefined);
    const cacheWriteInputTokens = optionalCount(usage.cache_creation_input_tokens ?? undefined);
    const outputTokens = optionalCount(usage.output_tokens);
    if (inputTokens !== undefined) candidate.inputTokens = inputTokens;
    if (cachedInputTokens !== undefined) candidate.cachedInputTokens = cachedInputTokens;
    if (cacheWriteInputTokens !== undefined)
      candidate.cacheWriteInputTokens = cacheWriteInputTokens;
    if (outputTokens !== undefined) candidate.outputTokens = outputTokens;
  }
  if (model?.contextWindow !== undefined) {
    const contextWindowTokens = optionalCount(model.contextWindow);
    const metaContextUsed = result.meta?.["codebuddy.ai/contextUsed"];
    const contextUsedTokens = optionalCount(
      typeof metaContextUsed === "number" ? metaContextUsed : undefined,
    );
    if (
      contextWindowTokens !== undefined &&
      contextWindowTokens > 0 &&
      contextUsedTokens !== undefined
    ) {
      candidate.contextWindowTokens = contextWindowTokens;
      candidate.contextUsedTokens = contextUsedTokens;
    }
  }
  if (
    result.totalCostUsd !== null &&
    Number.isFinite(result.totalCostUsd) &&
    result.totalCostUsd >= 0
  ) {
    candidate.totalCostUsd = result.totalCostUsd;
  }
  if (Object.keys(candidate).length === 0) return null;
  return parseHostUsage(candidate);
}
