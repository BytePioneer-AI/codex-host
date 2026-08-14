import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";

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

export function lastTurnUsage(
  events: ReadonlyArray<{ type: string; usage?: unknown }>,
): HostUsage | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "turn.completed") continue;
    const usage = usageFromNative(event.usage);
    if (usage) return usage;
  }
  return null;
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
