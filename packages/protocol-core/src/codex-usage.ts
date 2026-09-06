import type { HostUsage } from "@codexhost/harness-adapter";
import type { HostTurnId, JsonObject } from "@codexhost/shared-contracts";

export interface CodexThreadUsageProjectionInput {
  threadId: string;
  turnId?: HostTurnId;
  usage: HostUsage;
}

export function projectCodexThreadUsage(input: CodexThreadUsageProjectionInput): JsonObject | null {
  const { usage } = input;
  if (
    input.turnId === undefined ||
    usage.contextUsedTokens === undefined ||
    usage.contextWindowTokens === undefined
  ) {
    return null;
  }
  const total =
    usage.totalTokens === undefined
      ? {
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        }
      : {
          totalTokens: usage.totalTokens,
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
          cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
        };
  // `last` carries the native context window snapshot: Codex re-derives the
  // cache hit rate from `last.cachedInputTokens / last.inputTokens`, so the
  // cache split of the used context must pass through instead of being pinned
  // to zero. Clamp so the cached + cache-write parts never exceed the context.
  const contextUsedTokens = usage.contextUsedTokens;
  const cachedInputTokens = Math.min(usage.cachedInputTokens ?? 0, contextUsedTokens);
  const cacheWriteInputTokens = Math.min(
    usage.cacheWriteInputTokens ?? 0,
    Math.max(0, contextUsedTokens - cachedInputTokens),
  );
  return {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: input.threadId,
      turnId: input.turnId,
      tokenUsage: {
        total,
        last: {
          totalTokens: contextUsedTokens,
          inputTokens: contextUsedTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: usage.contextWindowTokens,
      },
    },
  };
}
