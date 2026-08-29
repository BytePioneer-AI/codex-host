import type { SessionUpdate } from "@agentclientprotocol/sdk";
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

/** Qwen Code reports cumulative request Usage in message chunk metadata. */
export function usageFromMetadata(metadata: Record<string, unknown> | undefined): HostUsage | null {
  const usage = metadata?.usage;
  if (!isRecord(usage)) return null;
  const cachedRead = optionalToken(usage.cachedInputTokens ?? usage.cachedTokens);
  const reasoning = optionalToken(usage.thoughtTokens ?? usage.reasoningTokens);
  try {
    return parseHostUsage({
      ...(optionalToken(usage.inputTokens) !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(optionalToken(usage.outputTokens) !== undefined
        ? { outputTokens: usage.outputTokens }
        : {}),
      ...(optionalToken(usage.totalTokens) !== undefined ? { totalTokens: usage.totalTokens } : {}),
      ...(cachedRead !== undefined ? { cachedInputTokens: cachedRead } : {}),
      ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
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
      return parseHostUsage({
        contextUsedTokens: (update as unknown as Record<string, unknown>).used,
        contextWindowTokens: (update as unknown as Record<string, unknown>).size,
      });
    }
    const fromMetadata = usageFromMetadata(metadata);
    if (!fromMetadata) return null;
    if (contextWindowTokens === undefined) return fromMetadata;
    return parseHostUsage({
      ...fromMetadata,
      contextUsedTokens: fromMetadata.totalTokens ?? fromMetadata.inputTokens,
      contextWindowTokens,
    });
  } catch {
    return null;
  }
}

/** The latest cumulative Usage observed in a replayed Qwen Code history. */
export function sessionUsageFromReplay(
  events: ReadonlyArray<{
    type: string;
    metadata?: Record<string, unknown>;
  }>,
  contextWindowTokensByModel: ReadonlyMap<string, number>,
  modelId: string | undefined,
): HostUsage | null {
  let usage: HostUsage | null = null;
  for (const event of events) {
    const candidate = usageFromMetadata(event.metadata);
    if (candidate) usage = candidate;
  }
  if (!usage) return null;
  const contextWindowTokens = modelId ? contextWindowTokensByModel.get(modelId) : undefined;
  if (contextWindowTokens === undefined) return usage;
  try {
    return parseHostUsage({
      ...usage,
      contextUsedTokens: usage.totalTokens ?? usage.inputTokens,
      contextWindowTokens,
    });
  } catch {
    return usage;
  }
}
