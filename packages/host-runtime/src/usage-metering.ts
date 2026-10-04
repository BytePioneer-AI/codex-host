import {
  hostDerivedUsageFields,
  parseHostUsage,
  parseHostUsageRequest,
  type HostUsage,
  type HostUsageRequest,
} from "@codexhost/harness-adapter";

import type { ModelPriceLookup } from "./model-prices.js";

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * In-memory usage metering for one External Thread's current HarnessSession. It derives cost,
 * session cache hit rate, time to first output and Turn output speed from the Adapter's
 * request records; it never persists and never rewrites the Adapter's native fields.
 */
export class UsageMeter {
  readonly #requests = new Map<string, HostUsageRequest>();
  /** Set by the first `usage.history`: this Session's cost now comes from Host metering. */
  #metered = false;
  #historyComplete = false;
  #invalidRecord = false;

  #turnId: string | null = null;
  #turnStartedAtMs: number | null = null;
  #turnOutputObserved = false;
  #turnOutputTokens = 0;
  #turnOutputMs = 0;
  #timeToFirstOutputMs: number | undefined;
  #outputTokensPerSecond: number | undefined;

  get metered(): boolean {
    return this.#metered;
  }

  /** Records one request; returns false only for a duplicate, which changes nothing. */
  recordRequest(value: unknown, activeTurnId: string | null): boolean {
    let request: HostUsageRequest;
    try {
      request = parseHostUsageRequest(value);
    } catch {
      this.#invalidRecord = true;
      return true;
    }
    if (this.#requests.has(request.requestId)) return false;
    this.#requests.set(request.requestId, request);
    const duration =
      request.startedAtMs !== undefined && request.completedAtMs !== undefined
        ? request.completedAtMs - request.startedAtMs
        : 0;
    if (
      !request.historical &&
      duration > 0 &&
      activeTurnId !== null &&
      activeTurnId === this.#turnId
    ) {
      this.#turnOutputTokens += request.outputTokens;
      this.#turnOutputMs += duration;
      // Running average of the Turn so far; the previous Turn's value stays until now.
      this.#outputTokensPerSecond = this.#turnOutputTokens / (this.#turnOutputMs / 1000);
    }
    return true;
  }

  recordHistory(complete: boolean): void {
    this.#metered = true;
    this.#historyComplete = complete;
  }

  turnStarted(turnId: string, nowMs: number): void {
    this.#turnId = turnId;
    this.#turnStartedAtMs = nowMs;
    this.#turnOutputObserved = false;
    this.#turnOutputTokens = 0;
    this.#turnOutputMs = 0;
  }

  /** Returns true when this is the Turn's first visible output. */
  outputObserved(turnId: string, nowMs: number): boolean {
    if (turnId !== this.#turnId || this.#turnOutputObserved || this.#turnStartedAtMs === null) {
      return false;
    }
    this.#turnOutputObserved = true;
    this.#timeToFirstOutputMs = Math.max(0, Math.round(nowMs - this.#turnStartedAtMs));
    return true;
  }

  turnCompleted(turnId: string): void {
    if (turnId !== this.#turnId) return;
    // A Turn without timed requests publishes no speed rather than a stale one.
    if (this.#turnOutputMs === 0) this.#outputTokensPerSecond = undefined;
    this.#turnId = null;
    this.#turnStartedAtMs = null;
  }

  /** The Thread's published usage: native fields plus Host-derived metrics. */
  derive(native: HostUsage | null, prices: ModelPriceLookup): HostUsage | null {
    // Fields only Host may publish are dropped from the Adapter's snapshot.
    const usage = Object.fromEntries(
      Object.entries(native ?? {}).filter(
        ([field]) => !(hostDerivedUsageFields as readonly string[]).includes(field),
      ),
    ) as HostUsage;
    if (this.#metered) {
      delete usage.totalCostUsd;
      delete usage.outputTokensPerSecond;
      if (this.#historyComplete && !this.#invalidRecord) {
        const cost = this.#cost(prices);
        if (cost !== null) {
          usage.totalCostUsd = cost;
          usage.costSource = "publicPrice";
        }
        const cacheHitRate = this.#sessionCacheHitRatePercent();
        if (cacheHitRate !== null) usage.sessionCacheHitRatePercent = cacheHitRate;
      }
      if (this.#outputTokensPerSecond !== undefined) {
        usage.outputTokensPerSecond = this.#outputTokensPerSecond;
      }
    } else if (usage.totalCostUsd !== undefined) {
      usage.costSource = "native";
    }
    if (this.#timeToFirstOutputMs !== undefined) {
      usage.timeToFirstOutputMs = this.#timeToFirstOutputMs;
    }
    if (Object.keys(usage).length === 0) return null;
    try {
      return parseHostUsage(usage);
    } catch {
      return native;
    }
  }

  #cost(prices: ModelPriceLookup): number | null {
    let total = 0;
    for (const request of this.#requests.values()) {
      const cacheRead = request.cachedInputTokens;
      const cacheWrite = request.cacheWriteInputTokens;
      if (request.model === undefined || cacheRead === undefined || cacheWrite === undefined) {
        return null;
      }
      const price = prices.find(request.model, request.provider);
      if (!price) return null;
      if (cacheRead > 0 && price.cacheRead === undefined) return null;
      if (cacheWrite > 0 && price.cacheWrite === undefined) return null;
      total +=
        ((request.inputTokens - cacheRead - cacheWrite) * price.input +
          cacheRead * (price.cacheRead ?? 0) +
          cacheWrite * (price.cacheWrite ?? 0) +
          request.outputTokens * price.output) /
        TOKENS_PER_PRICE_UNIT;
    }
    return total;
  }

  #sessionCacheHitRatePercent(): number | null {
    let input = 0;
    let cached = 0;
    for (const request of this.#requests.values()) {
      if (request.cachedInputTokens === undefined) return null;
      input += request.inputTokens;
      cached += request.cachedInputTokens;
    }
    return input > 0 ? (cached / input) * 100 : null;
  }
}
