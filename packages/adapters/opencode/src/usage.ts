import type { AssistantMessage } from "@opencode-ai/sdk/v2";

import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";

export function projectOpenCodeUsage(
  messages: readonly AssistantMessage[],
  contextWindowTokens?: number,
): HostUsage | null {
  if (messages.length === 0) return null;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const message of messages) {
    inputTokens += message.tokens.input;
    cachedInputTokens += message.tokens.cache.read;
    cacheWriteInputTokens += message.tokens.cache.write;
    outputTokens += message.tokens.output;
    reasoningOutputTokens += message.tokens.reasoning;
    totalTokens +=
      message.tokens.total ??
      message.tokens.input +
        message.tokens.cache.read +
        message.tokens.cache.write +
        message.tokens.output +
        message.tokens.reasoning;
    totalCostUsd += message.cost;
  }
  const latest = messages.at(-1) as AssistantMessage;
  const contextUsedTokens =
    latest.tokens.input + latest.tokens.cache.read + latest.tokens.cache.write;
  const promptTokens = inputTokens + cachedInputTokens + cacheWriteInputTokens;
  return parseHostUsage({
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    totalCostUsd,
    ...(promptTokens > 0 ? { cacheHitRatePercent: (cachedInputTokens / promptTokens) * 100 } : {}),
    ...(contextWindowTokens
      ? {
          contextUsedTokens,
          contextWindowTokens,
        }
      : {}),
  });
}
