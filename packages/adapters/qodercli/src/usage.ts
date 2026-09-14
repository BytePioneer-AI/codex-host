import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseQoderResultUsage(message: unknown): HostUsage | null {
  if (!isRecord(message) || message.type !== "result") return null;
  const usage = isRecord(message.usage) ? message.usage : {};
  const raw: HostUsage = {
    ...(optionalInteger(usage.input_tokens) !== undefined
      ? { inputTokens: usage.input_tokens as number }
      : {}),
    ...(optionalInteger(usage.output_tokens) !== undefined
      ? { outputTokens: usage.output_tokens as number }
      : {}),
    ...(optionalInteger(usage.cache_read_input_tokens) !== undefined
      ? { cachedInputTokens: usage.cache_read_input_tokens as number }
      : {}),
    ...(optionalInteger(usage.cache_creation_input_tokens) !== undefined
      ? { cacheWriteInputTokens: usage.cache_creation_input_tokens as number }
      : {}),
    ...(optionalNumber(message.total_credits) !== undefined
      ? { totalCredits: message.total_credits as number }
      : {}),
    ...(optionalNumber(message.total_cost_usd) !== undefined
      ? { totalCostUsd: message.total_cost_usd as number }
      : {}),
  };
  try {
    return parseHostUsage(raw);
  } catch {
    return null;
  }
}

export function parseQoderContextUsage(value: unknown): HostUsage | null {
  if (!isRecord(value)) return null;
  const window = isRecord(value.contextWindow) ? value.contextWindow : {};
  const raw: HostUsage = {
    ...(optionalNumber(window.usedPercentage) !== undefined
      ? { contextUsagePercent: window.usedPercentage as number }
      : {}),
  };
  try {
    return parseHostUsage(raw);
  } catch {
    return null;
  }
}
