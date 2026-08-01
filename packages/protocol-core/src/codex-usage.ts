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
  return {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: input.threadId,
      turnId: input.turnId,
      tokenUsage: {
        total,
        last: {
          totalTokens: usage.contextUsedTokens,
          inputTokens: usage.contextUsedTokens,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: usage.contextWindowTokens,
      },
    },
  };
}
