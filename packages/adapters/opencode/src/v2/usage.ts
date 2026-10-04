import { parseHostUsageRequest, type HostUsageRequest } from "@codexhost/harness-adapter";
import type { SessionMessageInfo } from "@opencode/client";

/**
 * One OpenCode v2 assistant message is one model step. OpenCode reports input without cache
 * and output without reasoning; the request adds both back. A step without Tokens never
 * finished, so it has no usage. Title and compaction usage is not a message and has no Model,
 * so it is not metered.
 */
export function v2UsageRequest(
  message: SessionMessageInfo,
  historical: boolean,
): HostUsageRequest | null {
  if (message.type !== "assistant" || !message.tokens) return null;
  const { input, output, reasoning, cache } = message.tokens;
  const { created, completed } = message.time;
  return parseHostUsageRequest({
    requestId: message.id,
    ...(historical ? { historical: true } : {}),
    model: message.model.id,
    // Built-in OpenCode providers use models.dev IDs. A custom provider ID matches no price
    // entry, so Host falls back to the exact model ID.
    provider: message.model.providerID,
    inputTokens: input + cache.read + cache.write,
    cachedInputTokens: cache.read,
    cacheWriteInputTokens: cache.write,
    outputTokens: output + reasoning,
    reasoningOutputTokens: reasoning,
    // The whole step, like a gateway's request duration, so hidden reasoning is not excluded.
    ...(!historical && completed !== undefined && completed >= created
      ? { startedAtMs: created, completedAtMs: completed }
      : {}),
  });
}
