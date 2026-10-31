import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function combineUsage(base: HostUsage | null, next: HostUsage | null): HostUsage | null {
  if (next === null) return base;
  return base === null ? next : parseHostUsage({ ...base, ...next });
}

/** Projects the Qwen SDK's ExtendedUsage object into Host Usage. */
export function usageFromMetadata(metadata: Record<string, unknown> | undefined): HostUsage | null {
  const usage = metadata?.usage;
  if (!isRecord(usage)) return null;
  const cachedRead = optionalToken(
    usage.cachedInputTokens ??
      usage.cachedReadTokens ??
      usage.cachedTokens ??
      usage.cache_read_input_tokens,
  );
  const reasoning = optionalToken(
    usage.thoughtTokens ?? usage.reasoningTokens ?? usage.thinking_tokens,
  );
  const inputTokens = optionalToken(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = optionalToken(usage.outputTokens ?? usage.output_tokens);
  const totalTokens = optionalToken(usage.totalTokens ?? usage.total_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedRead === undefined &&
    reasoning === undefined
  ) {
    return null;
  }
  try {
    return parseHostUsage({
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(cachedRead !== undefined ? { cachedInputTokens: cachedRead } : {}),
      ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
    });
  } catch {
    return null;
  }
}
