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

export const QODER_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

export function resolveQoderContextWindow(modelId?: string, reportedWindow?: number): number {
  if (reportedWindow && reportedWindow > 0) return reportedWindow;
  if (modelId && /gemini/iu.test(modelId)) return 1_048_576;
  return QODER_DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export class QoderUsageTracker {
  #inputTokens: number | undefined;
  #outputTokens: number | undefined;
  #cachedInputTokens: number | undefined;
  #cacheWriteInputTokens: number | undefined;
  #totalCredits: number | undefined;
  #totalCostUsd: number | undefined;
  #contextUsagePercent: number | undefined;
  #contextWindowTokens: number;
  #contextUsedTokens: number | undefined;

  constructor(options?: {
    modelId?: string | undefined;
    contextWindowTokens?: number | undefined;
  }) {
    this.#contextWindowTokens =
      options?.contextWindowTokens && options.contextWindowTokens > 0
        ? options.contextWindowTokens
        : resolveQoderContextWindow(options?.modelId);
  }

  setModel(modelId?: string): void {
    if (modelId) {
      this.#contextWindowTokens = resolveQoderContextWindow(modelId);
    }
  }

  observeAssistant(message: SDKAssistantMessage): void {
    const rawUsage = message.message?.usage as Record<string, unknown> | undefined;
    if (!rawUsage) return;

    if (isNonNegativeSafeInteger(rawUsage.input_tokens)) {
      this.#inputTokens = (this.#inputTokens ?? 0) + rawUsage.input_tokens;
    }
    if (isNonNegativeSafeInteger(rawUsage.output_tokens)) {
      this.#outputTokens = (this.#outputTokens ?? 0) + rawUsage.output_tokens;
    }
    if (isNonNegativeSafeInteger(rawUsage.cache_read_input_tokens)) {
      this.#cachedInputTokens = (this.#cachedInputTokens ?? 0) + rawUsage.cache_read_input_tokens;
    }
    if (isNonNegativeSafeInteger(rawUsage.cache_creation_input_tokens)) {
      this.#cacheWriteInputTokens =
        (this.#cacheWriteInputTokens ?? 0) + rawUsage.cache_creation_input_tokens;
    }
    // Assistant message usage may also contain credits for this turn
    if (isNonNegativeFinite(rawUsage.credits)) {
      // If we don't have a result-level total_credits snapshot yet, we can track latest known credits
      if (this.#totalCredits === undefined) {
        this.#totalCredits = rawUsage.credits;
      }
    }
    if (isNonNegativeFinite(rawUsage.context_usage_ratio)) {
      this.#contextUsagePercent = Math.min(100, Math.max(0, rawUsage.context_usage_ratio * 100));
    }
  }

  observeResult(result: SDKResultMessage): void {
    const rawResult = result as unknown as Record<string, unknown>;

    // total_credits is a cumulative session snapshot from Qoder.
    // It MUST replace the previous value, NOT accumulate!
    if (isNonNegativeFinite(rawResult.total_credits)) {
      this.#totalCredits = rawResult.total_credits as number;
    }

    if (isNonNegativeFinite(rawResult.total_cost_usd)) {
      this.#totalCostUsd = rawResult.total_cost_usd as number;
    }

    const usage = result.usage as Record<string, unknown> | undefined;
    if (usage) {
      if (isNonNegativeSafeInteger(usage.input_tokens)) {
        this.#inputTokens = usage.input_tokens as number;
      }
      if (isNonNegativeSafeInteger(usage.output_tokens)) {
        this.#outputTokens = usage.output_tokens as number;
      }
      if (isNonNegativeSafeInteger(usage.cache_read_input_tokens)) {
        this.#cachedInputTokens = usage.cache_read_input_tokens as number;
      }
      if (isNonNegativeSafeInteger(usage.cache_creation_input_tokens)) {
        this.#cacheWriteInputTokens = usage.cache_creation_input_tokens as number;
      }
      if (isNonNegativeFinite(usage.context_usage_ratio)) {
        this.#contextUsagePercent = Math.min(
          100,
          Math.max(0, (usage.context_usage_ratio as number) * 100),
        );
      }
    }

    if (
      this.#totalCostUsd === undefined &&
      rawResult.modelUsage &&
      typeof rawResult.modelUsage === "object"
    ) {
      let sumCost = 0;
      let hasCost = false;
      for (const modelInfo of Object.values(rawResult.modelUsage as Record<string, unknown>)) {
        if (modelInfo && typeof modelInfo === "object") {
          const cost =
            (modelInfo as Record<string, unknown>).costUSD ??
            (modelInfo as Record<string, unknown>).cost_usd;
          if (isNonNegativeFinite(cost)) {
            sumCost += cost as number;
            hasCost = true;
          }
        }
      }
      if (hasCost) {
        this.#totalCostUsd = sumCost;
      }
    }
  }

  observeContextUsage(context: QoderContextUsage): void {
    const raw = context as Record<string, unknown>;
    const contextWindow = (raw.contextWindow ?? {}) as Record<string, unknown>;

    const percent =
      typeof contextWindow.usedPercentage === "number"
        ? contextWindow.usedPercentage
      : typeof raw.usedPercentage === "number"
        ? raw.usedPercentage
        : undefined;
    if (isNonNegativeFinite(percent) && percent <= 100) {
      this.#contextUsagePercent = percent;
    }

    const maxTokens =
      typeof contextWindow.maxTokens === "number"
        ? contextWindow.maxTokens
      : typeof raw.maxTokens === "number"
        ? raw.maxTokens
        : undefined;
    if (isNonNegativeSafeInteger(maxTokens) && maxTokens > 0) {
      this.#contextWindowTokens = maxTokens;
    }

    const totalTokens =
      typeof contextWindow.totalTokens === "number"
        ? contextWindow.totalTokens
      : typeof raw.totalTokens === "number"
        ? raw.totalTokens
        : undefined;
    if (isNonNegativeSafeInteger(totalTokens) && totalTokens >= 0) {
      this.#contextUsedTokens = totalTokens;
    }
  }

  observeUsageInfo(info: unknown): void {
    if (!info || typeof info !== "object") return;
    const raw = info as Record<string, unknown>;
    const session = (raw.session ?? raw) as Record<string, unknown>;
    const credits =
      session.total_credits ?? session.totalCredits ?? raw.total_credits ?? raw.totalCredits;
    if (isNonNegativeFinite(credits)) {
      this.#totalCredits = credits as number;
    }
  }

  snapshot(): HostUsage | null {
    const candidate: Record<string, unknown> = {};

    if (this.#inputTokens !== undefined) candidate.inputTokens = this.#inputTokens;
    if (this.#outputTokens !== undefined) candidate.outputTokens = this.#outputTokens;
    if (this.#cachedInputTokens !== undefined)
      candidate.cachedInputTokens = this.#cachedInputTokens;
    if (this.#cacheWriteInputTokens !== undefined)
      candidate.cacheWriteInputTokens = this.#cacheWriteInputTokens;

    if (this.#inputTokens !== undefined || this.#outputTokens !== undefined) {
      candidate.totalTokens = (this.#inputTokens ?? 0) + (this.#outputTokens ?? 0);
    }

    if (this.#totalCredits !== undefined) candidate.totalCredits = this.#totalCredits;
    if (this.#totalCostUsd !== undefined) candidate.totalCostUsd = this.#totalCostUsd;

    const windowTokens = this.#contextWindowTokens;
    let usedTokens = this.#contextUsedTokens;

    if (usedTokens === undefined && this.#contextUsagePercent !== undefined) {
      usedTokens = Math.round((windowTokens * this.#contextUsagePercent) / 100);
    } else if (
      usedTokens === undefined &&
      (this.#inputTokens !== undefined || this.#cachedInputTokens !== undefined)
    ) {
      usedTokens = (this.#inputTokens ?? 0) + (this.#cachedInputTokens ?? 0);
    }

    if (usedTokens !== undefined) {
      candidate.contextUsedTokens = usedTokens;
      candidate.contextWindowTokens = windowTokens;
      if (this.#contextUsagePercent === undefined && windowTokens > 0) {
        candidate.contextUsagePercent = Math.min(
          100,
          Math.max(0, (usedTokens / windowTokens) * 100),
        );
      } else if (this.#contextUsagePercent !== undefined) {
        candidate.contextUsagePercent = this.#contextUsagePercent;
      }
    } else if (this.#contextUsagePercent !== undefined) {
      candidate.contextUsagePercent = this.#contextUsagePercent;
    }

    if (Object.keys(candidate).length === 0) return null;

    try {
      return parseHostUsage(candidate);
    } catch {
      return null;
    }
  }
}
