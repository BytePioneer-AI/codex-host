import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
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

/**
 * Grok 1.0.46 emits tool.call after stream completion, before tool/permission waits.
 * The final stream ends when prompt resolves, before history/credits refresh. Like Pi,
 * time starts at received output, not request start. streamStartMs only identifies a
 * request: even an empty role frame can set it, so it is NOT a generation timestamp.
 */
export class GrokGenerationTiming {
  readonly #streams = new Map<
    number,
    { startedAtMs: number; completedAtMs?: number; reasoning: boolean }
  >();
  #current: { startedAtMs: number; completedAtMs?: number; reasoning: boolean } | undefined;
  #nativeTurnKey: string | undefined;
  #invalid = false;

  observe(event: GrokTransportEvent): void {
    if (event.type === "compaction.started") this.#invalid = true;
    if (event.type === "turn.completed" && event.nativeTurnKey === this.#nativeTurnKey)
      this.endStream();
    if (event.type !== "agent.text" && event.type !== "agent.thought" && event.type !== "tool.call")
      return;
    if (event.type !== "tool.call" && !event.text) return;
    const key = event.metadata?.streamStartMs;
    const promptId = event.metadata?.promptId;
    if (
      typeof key !== "number" ||
      !Number.isSafeInteger(key) ||
      key < 0 ||
      typeof promptId !== "string" ||
      !promptId
    ) {
      this.#invalid = true;
      return;
    }
    this.#nativeTurnKey ??= promptId;
    if (promptId !== this.#nativeTurnKey) {
      this.#invalid = true;
      return;
    }
    let stream = this.#streams.get(key);
    if (event.type === "tool.call") {
      // Parallel calls close the same stream once. Tool-only requests have no observed start.
      if (stream) stream.completedAtMs ??= Date.now();
      else this.#invalid = true;
      return;
    }
    if (!stream) {
      // A retry or missing end must not turn intervening waiting into generation time.
      if (this.#current && this.#current.completedAtMs === undefined) this.#invalid = true;
      stream = { startedAtMs: Date.now(), reasoning: false };
      this.#streams.set(key, stream);
      this.#current = stream;
    }
    if (stream.completedAtMs !== undefined) this.#invalid = true;
    if (event.type === "agent.thought") stream.reasoning = true;
  }

  endStream(): void {
    if (this.#current) this.#current.completedAtMs ??= Date.now();
  }

  rate(value: unknown, nativeTurnKey: string | undefined): number | undefined {
    if (
      this.#invalid ||
      nativeTurnKey !== this.#nativeTurnKey ||
      !isRecord(value) ||
      (value.usageIsIncomplete !== undefined && value.usageIsIncomplete !== false)
    )
      return undefined;
    const usage = usageFromNative(value);
    if (!usage?.outputTokens || value.modelCalls !== this.#streams.size || !this.#streams.size)
      return undefined;
    let durationMs = 0;
    for (const stream of this.#streams.values()) {
      // Turn-level reasoning cannot be attributed to individual requests. Require an
      // observed thought in every stream if any reasoning was billed; never time hidden thought.
      if ((usage.reasoningOutputTokens ?? 0) > 0 && !stream.reasoning) return undefined;
      const duration = (stream.completedAtMs ?? stream.startedAtMs) - stream.startedAtMs;
      if (duration <= 0) return undefined;
      durationMs += duration;
    }
    return (usage.outputTokens * 1000) / durationMs;
  }
}

export function usageFromPrompt(response: PromptResponse): HostUsage | null {
  return response.usage ? usageFromNative(response.usage) : null;
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

function historyTurnKey(event: { nativeTurnKey?: string }, index: number): string | null {
  const key = event.nativeTurnKey;
  if (typeof key === "string" && key.startsWith("task-completed-")) return null;
  return typeof key === "string" && key.length > 0 ? key : `anon-${index}`;
}

/** Sum persisted per-turn Grok Usage. Cache hit rate stays the latest request. */
export function sessionUsageFromHistory(
  events: ReadonlyArray<{ type: string; usage?: unknown; nativeTurnKey?: string }>,
): HostUsage | null {
  const latestByKey = new Map<string, { usage: HostUsage; ticks?: number }>();
  let lastCacheHitRatePercent: number | undefined;
  let index = 0;
  for (const event of events) {
    if (event?.type !== "turn.completed") continue;
    const key = historyTurnKey(event, index);
    index += 1;
    if (key === null) continue;
    const usage = usageFromNative(event.usage);
    if (!usage) continue;
    const ticks = nativeCostTicks(event.usage);
    latestByKey.set(key, ticks === undefined ? { usage } : { usage, ticks });
    if (usage.cacheHitRatePercent !== undefined) {
      lastCacheHitRatePercent = usage.cacheHitRatePercent;
    }
  }
  if (latestByKey.size === 0) return null;

  const totals: Partial<Record<(typeof summedUsageFields)[number], number>> = {};
  let ticks = 0;
  let hasTicks = false;
  for (const entry of latestByKey.values()) {
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
      ...(lastCacheHitRatePercent !== undefined
        ? { cacheHitRatePercent: lastCacheHitRatePercent }
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
