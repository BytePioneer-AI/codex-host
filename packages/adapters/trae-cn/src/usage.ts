import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import { record } from "./errors.js";

/** These counters describe the latest model context, not all Session requests. */
export function nativeContextUsage(value: unknown): HostUsage | null {
  if (!record(value)) return null;
  const used = value.last_turn_total_tokens,
    window = value.max_tokens;
  if (
    typeof used !== "number" ||
    !Number.isSafeInteger(used) ||
    used < 0 ||
    typeof window !== "number" ||
    !Number.isSafeInteger(window) ||
    window <= 0
  )
    return null;
  return parseHostUsage({
    contextUsedTokens: used,
    contextWindowTokens: window,
    contextUsagePercent: (100 * used) / window,
  });
}

export function contextUsageFromHistory(
  value: unknown,
  activeMessageId?: string,
): HostUsage | null {
  if (!record(value) || !Array.isArray(value.items)) return null;
  const messages = value.items.filter(
    (item): item is Record<string, unknown> =>
      record(item) &&
      item.role === "assistant" &&
      (!activeMessageId || item.reply_to_message_id === activeMessageId),
  );
  messages.sort((left, right) => Number(left.message_index) - Number(right.message_index));
  return nativeContextUsage(messages.at(-1)?.tokenUsage);
}
