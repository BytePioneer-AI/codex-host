import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type {
  QoderContextUsage,
  SDKAssistantMessage,
  SDKResultMessage,
} from "./qoder-sdk-types.js";

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export class QoderUsageTracker {
  #inputTokens: number | undefined;
  #outputTokens: number | undefined;
  #cachedInputTokens: number | undefined;
  #cacheWriteInputTokens: number | undefined;
  #totalCredits: number | undefined;
  #totalCostUsd: number | undefined;
  #contextUsagePercent: number | undefined;

  observeAssistant(message: SDKAssistantMessage): void {
    const usage = message.message?.usage;
    if (!usage) return;

    if (isNonNegativeSafeInteger(usage.input_tokens)) {
      this.#inputTokens = (this.#inputTokens ?? 0) + usage.input_tokens;
    }
    if (isNonNegativeSafeInteger(usage.output_tokens)) {
      this.#outputTokens = (this.#outputTokens ?? 0) + usage.output_tokens;
    }
    if (isNonNegativeSafeInteger(usage.cache_read_input_tokens)) {
      this.#cachedInputTokens = (this.#cachedInputTokens ?? 0) + usage.cache_read_input_tokens;
    }
    if (isNonNegativeSafeInteger(usage.cache_creation_input_tokens)) {
      this.#cacheWriteInputTokens =
        (this.#cacheWriteInputTokens ?? 0) + usage.cache_creation_input_tokens;
    }
    // Assistant message usage may also contain credits for this turn
    if (isNonNegativeFinite(usage.credits)) {
      // If we don't have a result-level total_credits snapshot yet, we can track latest known credits
      if (this.#totalCredits === undefined) {
        this.#totalCredits = usage.credits;
      }
    }
  }

  observeResult(result: SDKResultMessage): void {
    // total_credits is a cumulative session snapshot from Qoder.
    // It MUST replace the previous value, NOT accumulate!
    if (isNonNegativeFinite(result.total_credits)) {
      this.#totalCredits = result.total_credits;
    }

    const usage = result.usage;
    if (usage) {
      if (isNonNegativeSafeInteger(usage.input_tokens)) {
        this.#inputTokens = usage.input_tokens;
      }
      if (isNonNegativeSafeInteger(usage.output_tokens)) {
        this.#outputTokens = usage.output_tokens;
      }
      if (isNonNegativeSafeInteger(usage.cache_read_input_tokens)) {
        this.#cachedInputTokens = usage.cache_read_input_tokens;
      }
      if (isNonNegativeSafeInteger(usage.cache_creation_input_tokens)) {
        this.#cacheWriteInputTokens = usage.cache_creation_input_tokens;
      }
    }

    if (result.modelUsage && typeof result.modelUsage === "object") {
      let sumCost = 0;
      let hasCost = false;
      for (const modelInfo of Object.values(result.modelUsage)) {
        if (modelInfo && isNonNegativeFinite(modelInfo.costUSD)) {
          sumCost += modelInfo.costUSD;
          hasCost = true;
        }
      }
      if (hasCost) {
        this.#totalCostUsd = sumCost;
      }
    }
  }

  observeContextUsage(context: QoderContextUsage): void {
    const percent = context.contextWindow?.usedPercentage;
    if (isNonNegativeFinite(percent) && percent <= 100) {
      this.#contextUsagePercent = percent;
    }
  }

  snapshot(): HostUsage | null {
    const candidate: Record<string, unknown> = {};

    if (this.#inputTokens !== undefined) candidate.inputTokens = this.#inputTokens;
    if (this.#outputTokens !== undefined) candidate.outputTokens = this.#outputTokens;
    if (this.#cachedInputTokens !== undefined) candidate.cachedInputTokens = this.#cachedInputTokens;
    if (this.#cacheWriteInputTokens !== undefined)
      candidate.cacheWriteInputTokens = this.#cacheWriteInputTokens;
    if (this.#totalCredits !== undefined) candidate.totalCredits = this.#totalCredits;
    if (this.#totalCostUsd !== undefined) candidate.totalCostUsd = this.#totalCostUsd;
    if (this.#contextUsagePercent !== undefined)
      candidate.contextUsagePercent = this.#contextUsagePercent;

    if (Object.keys(candidate).length === 0) return null;

    try {
      return parseHostUsage(candidate);
    } catch {
      return null;
    }
  }
}
