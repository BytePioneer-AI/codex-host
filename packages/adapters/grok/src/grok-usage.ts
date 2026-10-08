import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type { GrokTransportEvent } from "./acp-transport.js";

/** Grok documents `costUsdTicks` as integer ticks where 1 USD = 10^10. */
const USD_TICKS_PER_DOLLAR = 10_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalToken(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalCostUsd(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value / USD_TICKS_PER_DOLLAR;
}

export function combineUsage(base: HostUsage | null, next: HostUsage | null): HostUsage | null {
  if (next === null) return base;
  return base === null ? next : parseHostUsage({ ...base, ...next });
}

// Persisted API duration includes prefill. Only live stream observations below supply TPS.
export function usageFromNative(value: unknown): HostUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = optionalToken(value.inputTokens);
  const cachedRead = optionalToken(value.cachedReadTokens);
  const cachedWrite = optionalToken(value.cacheCreationTokens ?? value.cachedWriteTokens);
  const reasoning = optionalToken(value.reasoningTokens ?? value.thoughtTokens);
  const totalCostUsd = optionalCostUsd(value.costUsdTicks);
  const cacheHitRatePercent =
    inputTokens !== undefined &&
    cachedRead !== undefined &&
    inputTokens > 0 &&
    cachedRead <= inputTokens
      ? (cachedRead / inputTokens) * 100
      : undefined;
  try {
    return parseHostUsage({
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(optionalToken(value.outputTokens) !== undefined
        ? { outputTokens: value.outputTokens }
        : {}),
      ...(optionalToken(value.totalTokens) !== undefined ? { totalTokens: value.totalTokens } : {}),
      ...(cachedRead !== undefined ? { cachedInputTokens: cachedRead } : {}),
      ...(cachedWrite !== undefined ? { cacheWriteInputTokens: cachedWrite } : {}),
      ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
      ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      ...(cacheHitRatePercent !== undefined ? { cacheHitRatePercent } : {}),
    });
  } catch {
    return null;
  }
}

/** response_completed uses disjoint Messages-style input buckets, unlike PromptUsage. */
function usageFromResponse(value: unknown): HostUsage | null {
  if (!isRecord(value)) return null;
  const buckets = [
    value.input_tokens,
    value.cache_read_input_tokens,
    value.cache_creation_input_tokens,
  ];
  const inputTokens = buckets.every(
    (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
  )
    ? (buckets as number[]).reduce((sum, n) => sum + n, 0)
    : undefined;
  const outputTokens = optionalToken(value.output_tokens);
  return usageFromNative({
    inputTokens,
    outputTokens,
    cachedReadTokens: value.cache_read_input_tokens,
    cacheCreationTokens: value.cache_creation_input_tokens,
    reasoningTokens: value.reasoning_tokens,
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
  });
}

/** Live request observations only. Never time replay, tool execution or settlement I/O. */
export class GrokTurnUsage {
  readonly #totals: HostUsage = {};
  readonly #seen = new Set<string>();
  #cacheComplete: boolean;
  #compacting = false;
  #startedAtMs: number | undefined;
  #streamKey: unknown;
  #outputTokens = 0;
  #durationMs = 0;
  #latestCacheHit: number | undefined;

  constructor(base: HostUsage | null, emptySession = false) {
    for (const field of summedUsageFields) {
      const value = base?.[field];
      if (value !== undefined) this.#totals[field] = value;
    }
    this.#cacheComplete = base?.sessionCacheUsage !== undefined || emptySession;
  }

  observe(event: GrokTransportEvent): HostUsage | null {
    if (event.type === "compaction.started" || event.type === "compaction.completed") {
      this.#startedAtMs = undefined;
      this.#streamKey = undefined;
      this.#compacting = event.type === "compaction.started";
    }
    if (this.#compacting) return null;
    // Subagent accounting is folded into the native Turn ledger at settlement.
    if (event.type === "subagent.spawned") this.#cacheComplete = false;
    if (
      event.type === "agent.text" ||
      event.type === "agent.thought" ||
      event.type === "tool.input.delta"
    ) {
      if (!event.text) return null;
      const key = event.metadata?.streamStartMs;
      if (key !== undefined && this.#streamKey !== undefined && key !== this.#streamKey)
        this.#startedAtMs = undefined;
      if (key !== undefined) this.#streamKey = key;
      this.#startedAtMs ??= Date.now();
    }
    if (event.type !== "response.completed") return null;
    if (event.messageId) {
      if (this.#seen.has(event.messageId)) return null;
      this.#seen.add(event.messageId);
    }
    const duration = this.#startedAtMs === undefined ? 0 : Date.now() - this.#startedAtMs;
    this.#startedAtMs = undefined;
    this.#streamKey = undefined;
    const usage = usageFromResponse(event.usage);
    this.#latestCacheHit = usage?.cacheHitRatePercent;
    if (usage?.inputTokens === undefined || usage.cachedInputTokens === undefined)
      this.#cacheComplete = false;
    if (usage) {
      for (const field of summedUsageFields) {
        const value = usage[field];
        if (value !== undefined) this.#totals[field] = (this.#totals[field] ?? 0) + value;
      }
      if (duration > 0 && usage.outputTokens !== undefined) {
        this.#outputTokens += usage.outputTokens;
        this.#durationMs += duration;
      }
    }
    return this.snapshot();
  }

  metrics(): HostUsage {
    return {
      ...(this.#durationMs > 0
        ? { outputTokensPerSecond: (this.#outputTokens * 1000) / this.#durationMs }
        : {}),
      ...(this.#latestCacheHit !== undefined ? { cacheHitRatePercent: this.#latestCacheHit } : {}),
    };
  }

  snapshot(): HostUsage {
    const inputTokens = this.#totals.inputTokens;
    const cachedInputTokens = this.#totals.cachedInputTokens;
    return {
      ...this.#totals,
      ...this.metrics(),
      ...(this.#cacheComplete && inputTokens !== undefined && cachedInputTokens !== undefined
        ? { sessionCacheUsage: { inputTokens, cachedInputTokens } }
        : {}),
    };
  }
}

export function usageFromSignals(value: unknown): HostUsage | null {
  if (!isRecord(value)) return null;
  try {
    return parseHostUsage({
      contextUsedTokens: value.contextTokensUsed,
      contextWindowTokens: value.contextWindowTokens,
    });
  } catch {
    return null;
  }
}

const summedUsageFields = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;

function nativeCostTicks(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const ticks = value.costUsdTicks;
  if (typeof ticks !== "number" || !Number.isSafeInteger(ticks) || ticks < 0) return undefined;
  return ticks;
}

/** Add the fixed history baseline once; live RPC snapshots are cumulative, not deltas. */
export function sessionCostFromNative(value: unknown, initialCostUsd: number): number | undefined {
  if (!isRecord(value)) return undefined;
  if (value.costIsPartial !== undefined && value.costIsPartial !== false) return undefined;
  if (value.usageIsIncomplete !== undefined && value.usageIsIncomplete !== false) return undefined;
  const ticks = nativeCostTicks(value);
  return ticks === undefined
    ? undefined
    : optionalCostUsd(Math.round(initialCostUsd * USD_TICKS_PER_DOLLAR) + ticks);
}

function historyTurnKey(event: { nativeTurnKey?: string }, index: number): string | null {
  const key = event.nativeTurnKey;
  if (typeof key === "string" && key.startsWith("task-completed-")) return null;
  return typeof key === "string" && key.length > 0 ? key : `anon-${index}`;
}

/** Native Turn totals restore Session cache facts and fees, not a latest-request rate or TPS. */
export function sessionUsageFromHistory(
  events: ReadonlyArray<{ type: string; usage?: unknown; nativeTurnKey?: string }>,
): HostUsage | null {
  const latestByKey = new Map<
    string,
    { usage: HostUsage | null; complete: boolean; ticks?: number }
  >();
  let index = 0;
  for (const event of events) {
    if (event?.type !== "turn.completed") continue;
    const key = historyTurnKey(event, index);
    index += 1;
    if (key === null) continue;
    // Duplicate terminal markers without usage do not erase a previously recorded ledger.
    if (event.usage === undefined && latestByKey.has(key)) continue;
    const usage = usageFromNative(event.usage);
    const ticks = nativeCostTicks(event.usage);
    const complete =
      isRecord(event.usage) &&
      (event.usage.usageIsIncomplete === undefined || event.usage.usageIsIncomplete === false) &&
      usage?.inputTokens !== undefined &&
      usage.cachedInputTokens !== undefined &&
      usage.cachedInputTokens <= usage.inputTokens;
    latestByKey.set(key, { usage, complete, ...(ticks !== undefined ? { ticks } : {}) });
  }
  if (latestByKey.size === 0) return null;

  const totals: Partial<Record<(typeof summedUsageFields)[number], number>> = {};
  let ticks = 0;
  let hasTicks = false;
  for (const entry of latestByKey.values()) {
    if (!entry.usage) continue;
    for (const field of summedUsageFields) {
      const value = entry.usage[field];
      if (value === undefined) continue;
      totals[field] = (totals[field] ?? 0) + value;
    }
    if (entry.ticks === undefined) continue;
    ticks += entry.ticks;
    hasTicks = true;
  }
  const totalCostUsd = hasTicks ? optionalCostUsd(ticks) : undefined;
  try {
    return parseHostUsage({
      ...totals,
      ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      ...([...latestByKey.values()].every((entry) => entry.complete) &&
      totals.inputTokens !== undefined &&
      totals.cachedInputTokens !== undefined
        ? {
            sessionCacheUsage: {
              inputTokens: totals.inputTokens,
              cachedInputTokens: totals.cachedInputTokens,
            },
          }
        : {}),
    });
  } catch {
    return null;
  }
}

export function usageFromCompact(
  tokensAfter: number | undefined,
  contextWindowTokens: number | undefined,
): HostUsage | null {
  if (
    tokensAfter === undefined ||
    contextWindowTokens === undefined ||
    !Number.isSafeInteger(tokensAfter) ||
    tokensAfter < 0 ||
    !Number.isSafeInteger(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return null;
  }
  try {
    return parseHostUsage({
      contextUsedTokens: tokensAfter,
      contextWindowTokens,
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
    });
  } catch {
    return null;
  }
}
