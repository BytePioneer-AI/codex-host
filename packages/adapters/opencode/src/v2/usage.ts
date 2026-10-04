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
  firstOutputAtMs?: number,
): HostUsageRequest | null {
  if (message.type !== "assistant" || !message.tokens) return null;
  const { input, output, reasoning, cache } = message.tokens;
  const { completed } = message.time;
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
    // From the Adapter-observed first output event to native completion, excluding prefill.
    // OpenCode's own `time.streamed` marks the end of streaming, not its start. The local
    // OpenCode server shares this machine's clock.
    ...(!historical &&
    firstOutputAtMs !== undefined &&
    completed !== undefined &&
    completed >= firstOutputAtMs
      ? { startedAtMs: firstOutputAtMs, completedAtMs: completed }
      : {}),
  });
}
