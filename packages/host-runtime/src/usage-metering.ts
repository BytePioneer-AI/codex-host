import {
  hostDerivedUsageFields,
  parseHostUsage,
  parseHostUsageRequest,
  type HostUsage,
  type HostUsageRequest,
} from "@codexhost/harness-adapter";

import { cacheWrite1hPrice, type ModelPriceLookup } from "./model-prices.js";

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
  #timingUnavailable = false;
  readonly #timedRequests = new Set<string>();

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
      this.recordOutputTiming(
        {
          requestId: request.requestId,
          outputTokens: request.outputTokens,
          startedAtMs: request.startedAtMs ?? 0,
          completedAtMs: request.completedAtMs ?? 0,
        },
        activeTurnId,
      );
    }
    return true;
  }

  /** Live timing is independent of history replacement and cannot create billing entries. */
  recordOutputTiming(
    request: {
      requestId: string;
      outputTokens: number;
      startedAtMs: number;
      completedAtMs: number;
    },
    turnId: string,
  ): boolean {
    if (
      turnId !== this.#turnId ||
      this.#timingUnavailable ||
      this.#timedRequests.has(request.requestId)
    )
      return false;
    if (
      !request.requestId ||
      ![request.outputTokens, request.startedAtMs, request.completedAtMs].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      request.completedAtMs <= request.startedAtMs
    ) {
      this.invalidateOutputTiming(turnId);
      return true;
    }
    this.#timedRequests.add(request.requestId);
    this.#turnOutputTokens += request.outputTokens;
    this.#turnOutputMs += request.completedAtMs - request.startedAtMs;
    this.#outputTokensPerSecond = this.#turnOutputTokens / (this.#turnOutputMs / 1000);
    return true;
  }

  invalidateOutputTiming(turnId: string): void {
    if (turnId !== this.#turnId) return;
    this.#timingUnavailable = true;
  }

  /** Discard in-flight timing across connections, but keep the last valid displayed speed. */
  resetTurnTiming(): void {
    this.#turnId = null;
    this.#turnStartedAtMs = null;
    this.#timeToFirstOutputMs = undefined;
    this.#timedRequests.clear();
    this.#timingUnavailable = false;
  }

  /** Replace a read-only session history after recovery, append, rollback or file replacement. */
  replaceHistory(requests: readonly HostUsageRequest[], complete: boolean): void {
    this.#requests.clear();
    this.#invalidRecord = false;
    for (const request of requests) this.recordRequest({ ...request, historical: true }, null);
    this.recordHistory(complete);
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
    this.#timedRequests.clear();
    this.#timingUnavailable = false;
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
    // No new measurement does not erase the last valid speed.
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
    const sessionCacheUsage = usage.sessionCacheUsage;
    delete usage.sessionCacheUsage;
    if (!this.#metered && sessionCacheUsage) {
      try {
        parseHostUsage({ sessionCacheUsage });
        if (sessionCacheUsage.inputTokens > 0) {
          usage.sessionCacheHitRatePercent =
            (sessionCacheUsage.cachedInputTokens / sessionCacheUsage.inputTokens) * 100;
        }
      } catch {
        // Bad native cache facts must not discard independent native cost or speed.
      }
    }
    if (this.#metered) {
      delete usage.totalCostUsd;
      delete usage.outputTokensPerSecond;
      if (this.#historyComplete && !this.#invalidRecord) {
        const cost = this.#cost(prices);
        if (cost !== null) {
          usage.totalCostUsd = cost.total;
          usage.costSource = "publicPrice";
          if (cost.unpricedModels.length > 0) usage.unpricedModels = cost.unpricedModels;
        }
        const cacheHitRate = this.#sessionCacheHitRatePercent();
        if (cacheHitRate !== null) usage.sessionCacheHitRatePercent = cacheHitRate;
      }
    } else if (usage.totalCostUsd !== undefined) {
      usage.costSource = "native";
    }
    if (this.#timingUnavailable) delete usage.outputTokensPerSecond;
    if (this.#outputTokensPerSecond !== undefined)
      usage.outputTokensPerSecond = this.#outputTokensPerSecond;
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

  /**
   * Sums every priced request. A request whose Model has no price is left out and its Model
   * named, so the total is a lower bound; a request without Model or cache data voids the total,
   * as does a Session with no priced request at all.
   */
  #cost(prices: ModelPriceLookup): { total: number; unpricedModels: string[] } | null {
    let total = 0;
    let priced = 0;
    const unpriced = new Set<string>();
    for (const request of this.#requests.values()) {
      const cacheRead = request.cachedInputTokens;
      const cacheWrite = request.cacheWriteInputTokens;
      if (request.model === undefined || cacheRead === undefined || cacheWrite === undefined) {
        return null;
      }
      const price = prices.find(request.model, request.provider);
      const cacheWrite1h = request.cacheWrite1hInputTokens ?? 0;
      const cacheWrite5m = cacheWrite - cacheWrite1h;
      if (
        !price ||
        (cacheRead > 0 && price.cacheRead === undefined) ||
        (cacheWrite5m > 0 && price.cacheWrite === undefined)
      ) {
        unpriced.add(request.model);
        continue;
      }
      priced += 1;
      total +=
        ((request.inputTokens - cacheRead - cacheWrite) * price.input +
          cacheRead * (price.cacheRead ?? 0) +
          cacheWrite5m * (price.cacheWrite ?? 0) +
          cacheWrite1h * cacheWrite1hPrice(price) +
          request.outputTokens * price.output) /
        TOKENS_PER_PRICE_UNIT;
    }
    if (priced === 0 && unpriced.size > 0) return null;
    return { total, unpricedModels: [...unpriced].sort() };
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
