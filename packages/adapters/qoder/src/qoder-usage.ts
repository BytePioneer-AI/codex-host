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

function isContextWindow(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

/** The CLI reports bare model IDs and the built-in `qoder/` spelling interchangeably. */
function modelAlias(modelId: string): string | undefined {
  const prefix = "qoder/";
  const namespaced = modelId.startsWith(prefix);
  const id = namespaced ? modelId.slice(prefix.length) : modelId;
  if (!id || id.includes("/") || /\s/u.test(id)) return undefined;
  return namespaced ? id : `${prefix}${id}`;
}

export interface QoderConfiguredContextWindows {
  /** Model the CLI runs when the session did not pick one (`model.name`). */
  readonly defaultModelId?: string;
  /** Effective `model.preferences.<model>.contextWindow` values, keyed by native model id. */
  readonly windows: Readonly<Record<string, number>>;
}

/**
 * Reads the per-model context windows out of a `get_settings` control response.
 * Qoder CLIs (qoderclicn 1.1.81) answer `get_context_usage` with a percentage only, so the
 * effective `contextWindow` from settings is the only source for the window size.
 */
export function parseQoderConfiguredContextWindows(
  settings: unknown,
): QoderConfiguredContextWindows | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const effective = (settings as Record<string, unknown>).effective;
  if (!effective || typeof effective !== "object") return undefined;
  const model = (effective as Record<string, unknown>).model;
  if (!model || typeof model !== "object") return undefined;
  const { name, preferences } = model as Record<string, unknown>;

  const windows: Record<string, number> = Object.create(null) as Record<string, number>;
  if (preferences && typeof preferences === "object") {
    for (const [modelId, preference] of Object.entries(preferences as Record<string, unknown>)) {
      if (!preference || typeof preference !== "object") continue;
      const contextWindow = (preference as Record<string, unknown>).contextWindow;
      if (isContextWindow(contextWindow)) {
        windows[modelId] = contextWindow;
      }
    }
  }
  return {
    ...(typeof name === "string" && name.length > 0 ? { defaultModelId: name } : {}),
    windows,
  };
}

export class QoderUsageTracker {
  #inputTokens: number | undefined;
  #outputTokens: number | undefined;
  #cachedInputTokens: number | undefined;
  #cacheWriteInputTokens: number | undefined;
  #totalCredits: number | undefined;
  #totalCostUsd: number | undefined;
  #contextUsagePercent: number | undefined;
  #reportedWindow: number | undefined;
  #contextUsedTokens: number | undefined;
  #latestInputTokens: number | undefined;
  #cacheHitRatePercent: number | undefined;
  #planFiveHourUsedPercent: number | undefined;
  #planFiveHourResetsAtUnix: number | undefined;
  #turnCredits: number | undefined;
  #modelId: string | undefined;
  readonly #configuredWindows = new Map<string, number>();

  constructor(options?: { modelId?: string | undefined }) {
    this.setModel(options?.modelId);
  }

  setModel(modelId?: string): void {
    if (!modelId || modelId === this.#modelId) return;
    if (this.#modelId === undefined || modelAlias(modelId) !== this.#modelId) {
      this.#reportedWindow = undefined;
      this.#contextUsedTokens = undefined;
      this.#contextUsagePercent = undefined;
      this.#latestInputTokens = undefined;
    }
    this.#modelId = modelId;
  }

  /** A complete settings response replaces the previous settings, not the native reading. */
  setConfiguredContextWindows(configured: QoderConfiguredContextWindows): void {
    this.#configuredWindows.clear();
    for (const [modelId, window] of Object.entries(configured.windows)) {
      if (isContextWindow(window)) this.#configuredWindows.set(modelId, window);
    }
    this.#modelId ??= configured.defaultModelId;
  }

  #configuredWindow(): number | undefined {
    if (!this.#modelId) return undefined;
    const alias = modelAlias(this.#modelId);
    return (
      this.#configuredWindows.get(this.#modelId) ??
      (alias === undefined ? undefined : this.#configuredWindows.get(alias))
    );
  }

  observeAssistant(message: SDKAssistantMessage): void {
    const rawUsage = message.message?.usage as Record<string, unknown> | undefined;
    if (!rawUsage) return;

    const inputParts = [
      rawUsage.input_tokens,
      rawUsage.cache_read_input_tokens,
      rawUsage.cache_creation_input_tokens,
    ].filter(isNonNegativeSafeInteger);
    if (inputParts.length > 0) {
      this.#latestInputTokens = inputParts.reduce((sum, tokens) => sum + tokens, 0);
    }

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
      this.#turnCredits = (this.#turnCredits ?? 0) + rawUsage.credits;
      if (this.#totalCredits === undefined) {
        this.#totalCredits = this.#turnCredits;
      }
    }
    if (isNonNegativeFinite(rawUsage.context_usage_ratio)) {
      this.#contextUsagePercent = Math.min(100, Math.max(0, rawUsage.context_usage_ratio * 100));
    }
    if (
      isNonNegativeSafeInteger(rawUsage.input_tokens) &&
      rawUsage.input_tokens > 0 &&
      isNonNegativeSafeInteger(rawUsage.cache_read_input_tokens)
    ) {
      this.#cacheHitRatePercent = Math.min(
        100,
        Math.max(0, (rawUsage.cache_read_input_tokens / rawUsage.input_tokens) * 100),
      );
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
      if (
        isNonNegativeSafeInteger(usage.input_tokens) &&
        (usage.input_tokens as number) > 0 &&
        isNonNegativeSafeInteger(usage.cache_read_input_tokens)
      ) {
        this.#cacheHitRatePercent = Math.min(
          100,
          Math.max(
            0,
            ((usage.cache_read_input_tokens as number) / (usage.input_tokens as number)) * 100,
          ),
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

  observeContextUsage(context: QoderContextUsage | Record<string, unknown>): void {
    if (!context || typeof context !== "object") return;
    const raw = context as Record<string, unknown>;

    if (typeof raw.model === "string" && raw.model) {
      // Learning the native Model's ID is not a switch; keep samples already reported for it.
      if (this.#modelId === undefined) this.#modelId = raw.model;
      else this.setModel(raw.model);
    }

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
    if (isContextWindow(maxTokens)) this.#reportedWindow = maxTokens;

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
    const envelope = info as Record<string, unknown>;
    const usage = (
      envelope.usage && typeof envelope.usage === "object" ? envelope.usage : envelope
    ) as Record<string, unknown>;
    const session = (
      envelope.session && typeof envelope.session === "object"
        ? envelope.session
        : usage.session && typeof usage.session === "object"
          ? usage.session
          : usage
    ) as Record<string, unknown>;

    const credits =
      session.total_credits ??
      session.totalCredits ??
      envelope.total_credits ??
      envelope.totalCredits;
    if (isNonNegativeFinite(credits)) {
      this.#totalCredits = credits as number;
    }

    const userQuota = (
      usage.userQuota && typeof usage.userQuota === "object" ? usage.userQuota : undefined
    ) as Record<string, unknown> | undefined;

    const quotaPercent =
      typeof userQuota?.percentage === "number"
        ? userQuota.percentage
        : typeof usage.totalUsagePercentage === "number"
          ? usage.totalUsagePercentage
          : undefined;

    if (isNonNegativeFinite(quotaPercent) && quotaPercent <= 100) {
      this.#planFiveHourUsedPercent = quotaPercent;
    }

    const expiresAt = usage.expiresAt ?? userQuota?.resetsAt;
    if (typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > 0) {
      const unix = expiresAt > 1e11 ? Math.floor(expiresAt / 1000) : Math.floor(expiresAt);
      if (this.#planFiveHourUsedPercent !== undefined) {
        this.#planFiveHourResetsAtUnix = unix;
      }
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
    if (this.#cacheHitRatePercent !== undefined)
      candidate.cacheHitRatePercent = this.#cacheHitRatePercent;

    if (this.#planFiveHourUsedPercent !== undefined) {
      candidate.planFiveHourUsedPercent = this.#planFiveHourUsedPercent;
      if (this.#planFiveHourResetsAtUnix !== undefined) {
        candidate.planFiveHourResetsAtUnix = this.#planFiveHourResetsAtUnix;
      }
    }

    const percent = this.#contextUsagePercent;
    if (percent !== undefined) candidate.contextUsagePercent = percent;
    const windowTokens = this.#reportedWindow ?? this.#configuredWindow();
    if (windowTokens !== undefined) {
      const usedTokens =
        this.#contextUsedTokens ??
        (percent === undefined
          ? this.#latestInputTokens
          : Math.round(windowTokens * (percent / 100)));
      if (usedTokens !== undefined) {
        candidate.contextUsedTokens = usedTokens;
        candidate.contextWindowTokens = windowTokens;
        candidate.contextUsagePercent = percent ?? Math.min(100, (usedTokens / windowTokens) * 100);
      }
    }

    if (Object.keys(candidate).length === 0) return null;

    try {
      return parseHostUsage(candidate);
    } catch {
      return null;
    }
  }
}
