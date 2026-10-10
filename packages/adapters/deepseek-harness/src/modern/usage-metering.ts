import { parseHostUsageRequest, type HostUsageRequest } from "@codexhost/harness-adapter";

import { expandAssistantStream } from "../profiles/v4.js";
import type { ModernJournalEvent } from "./journal.js";

/**
 * Host usage metering for DeepSeek Harness (dsh) V4 journals. One settled `assistant/message`
 * (one `message.id`) is one model request. Shapes verified against a live dsh journal:
 * - `data.message.source` is `{ kind: "model", provider, model }`; `provider` is a dsh route
 *   name such as `deepseek-official`, not a models.dev ID, so only the model is published.
 * - usage is the stream's last `usage` chunk: `inputTokens` excludes cache reads and writes
 *   (`totalTokens` = input + output + cacheRead + cacheWrite), and `outputTokens` includes
 *   `reasoningTokens`.
 * - an interrupted message settles without a usage chunk; it reports no usage.
 * Timing mirrors dsh's own decode time: first non-empty reasoning, text or named tool-call delta
 * to the settled message.
 */

export type DeepSeekUsageRecord =
  { kind: "request"; request: HostUsageRequest } | { kind: "missing" } | { kind: "none" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstTokenTime(chunks: ReturnType<typeof expandAssistantStream>): number | null {
  for (const { time, chunk } of chunks) {
    if (
      ((chunk.type === "reasoning-delta" || chunk.type === "text-delta") &&
        typeof chunk.text === "string" &&
        chunk.text.length > 0) ||
      (chunk.type === "tool-call-delta" && typeof chunk.name === "string" && chunk.name.length > 0)
    ) {
      return time;
    }
  }
  return null;
}

/** The request record of one journal event; `none` for events that are not model requests. */
export function deepSeekUsageRecord(
  event: ModernJournalEvent,
  historical: boolean,
): DeepSeekUsageRecord {
  if (event.type !== "assistant/message" || event.surfaceOp !== "append") return { kind: "none" };
  const data = isRecord(event.data) ? event.data : null;
  const message = data && isRecord(data.message) ? data.message : null;
  const source = message && isRecord(message.source) ? message.source : null;
  if (!data || !message || source?.kind !== "model") return { kind: "none" };
  if (typeof message.id !== "string" || message.id.length === 0) return { kind: "missing" };
  if (typeof source.model !== "string" || source.model.length === 0) return { kind: "missing" };
  let chunks: ReturnType<typeof expandAssistantStream>;
  try {
    chunks = expandAssistantStream(data.stream);
  } catch {
    return { kind: "missing" };
  }
  let usage: unknown = data.usage;
  for (const { chunk } of chunks) if (chunk.type === "usage") usage = chunk.usage;
  // An interrupted request settles without usage: no tokens were reported for it.
  if (usage === undefined)
    return data.interrupted === true ? { kind: "none" } : { kind: "missing" };
  if (!isRecord(usage)) return { kind: "missing" };
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  const cacheRead = count(usage.cacheReadTokens ?? 0);
  const cacheWrite = count(usage.cacheWriteTokens ?? 0);
  const reasoning = usage.reasoningTokens === undefined ? null : count(usage.reasoningTokens);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    return { kind: "missing" };
  }
  const startedAtMs = historical ? null : firstTokenTime(chunks);
  const completedAtMs = typeof event.time === "number" ? event.time : null;
  try {
    return {
      kind: "request",
      request: parseHostUsageRequest({
        requestId: message.id,
        ...(historical ? { historical: true } : {}),
        model: source.model,
        inputTokens: input + cacheRead + cacheWrite,
        cachedInputTokens: cacheRead,
        cacheWriteInputTokens: cacheWrite,
        outputTokens: output,
        ...(reasoning !== null && reasoning <= output ? { reasoningOutputTokens: reasoning } : {}),
        ...(startedAtMs !== null && completedAtMs !== null && completedAtMs >= startedAtMs
          ? { startedAtMs, completedAtMs }
          : {}),
      }),
    };
  } catch {
    return { kind: "missing" };
  }
}

/** Every request in a journal, one per message ID. */
export function deepSeekUsageHistory(events: readonly ModernJournalEvent[]): {
  requests: HostUsageRequest[];
  complete: boolean;
} {
  const requests = new Map<string, HostUsageRequest>();
  let complete = true;
  for (const event of events) {
    const record = deepSeekUsageRecord(event, true);
    if (record.kind === "request") requests.set(record.request.requestId, record.request);
    else if (record.kind === "missing") complete = false;
  }
  return { requests: [...requests.values()], complete };
}
