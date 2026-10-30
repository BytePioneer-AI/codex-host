import { parseHostUsageRequest, type HostUsageRequest } from "@codexhost/harness-adapter";

/**
 * Host usage metering for Claude Code. One Anthropic Messages API response (one native
 * `message.id`) is one model request. Anthropic reports `input_tokens` without cache reads and
 * writes, and `output_tokens` including thinking; the request adds the cache back into input.
 *
 * Shapes verified against Claude Code 2.1.289:
 * - live stream: `stream_event` `message_start` carries `message.{id, model, usage}` with input
 *   and cache counts but `output_tokens: 1`; `message_delta.usage` carries the final counts,
 *   including `output_tokens_details.thinking_tokens`. The per-block `assistant` messages repeat
 *   the start usage, so they are not a usage source.
 * - transcript: every `assistant` entry repeats its message's final usage, with
 *   `cache_creation.ephemeral_{5m,1h}_input_tokens` splitting the cache writes.
 */

/** Claude Code's placeholder model for locally synthesized messages such as API errors. */
const SYNTHETIC_MODEL = "<synthetic>";

export type ClaudeUsageRecord =
  { kind: "request"; request: HostUsageRequest } | { kind: "missing" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Whether a native message model names a real model rather than a local placeholder. */
export function isClaudeModelRequest(model: unknown): model is string {
  return typeof model === "string" && model.length > 0 && model !== SYNTHETIC_MODEL;
}

/** Converts one Anthropic usage object of a completed message into a request record. */
export function claudeUsageRecord(
  requestId: string,
  model: string,
  usage: unknown,
  extra: { historical?: boolean; startedAtMs?: number | null; completedAtMs?: number } = {},
): ClaudeUsageRecord {
  if (!isRecord(usage)) return { kind: "missing" };
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_input_tokens ?? 0);
  const cacheWrite = count(usage.cache_creation_input_tokens ?? 0);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    return { kind: "missing" };
  }
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : null;
  const oneHour = split ? count(split.ephemeral_1h_input_tokens) : null;
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
  const thinking = details ? count(details.thinking_tokens) : null;
  const timed =
    extra.startedAtMs !== undefined &&
    extra.startedAtMs !== null &&
    extra.completedAtMs !== undefined;
  try {
    return {
      kind: "request",
      request: parseHostUsageRequest({
        requestId,
        ...(extra.historical ? { historical: true } : {}),
        model,
        // Claude Code's providers (first-party, Bedrock, Vertex, gateways) differ in model IDs,
        // not in list prices; the model ID alone resolves the price.
        inputTokens: input + cacheRead + cacheWrite,
        cachedInputTokens: cacheRead,
        cacheWriteInputTokens: cacheWrite,
        // Mirrors Claude Code's own pricing: one-hour writes are capped by the total writes.
        ...(oneHour !== null ? { cacheWrite1hInputTokens: Math.min(oneHour, cacheWrite) } : {}),
        outputTokens: output,
        ...(thinking !== null && thinking <= output ? { reasoningOutputTokens: thinking } : {}),
        ...(timed ? { startedAtMs: extra.startedAtMs, completedAtMs: extra.completedAtMs } : {}),
      }),
    };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Every main-session request in a Claude Code transcript, one per native message ID. Subagent
 * transcripts live in separate files and are not included. Synthetic messages are not requests.
 */
export function claudeUsageHistory(entries: readonly unknown[]): {
  requests: HostUsageRequest[];
  complete: boolean;
} {
  const usages = new Map<string, { model: string; usage: unknown }>();
  let complete = true;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "assistant" || entry.isSidechain === true) continue;
    const message = entry.message;
    if (!isRecord(message) || !isClaudeModelRequest(message.model)) continue;
    if (typeof message.id !== "string" || message.id.length === 0) {
      complete = false;
      continue;
    }
    usages.set(message.id, { model: message.model, usage: message.usage });
  }
  const requests: HostUsageRequest[] = [];
  for (const [id, { model, usage }] of usages) {
    const record = claudeUsageRecord(id, model, usage, { historical: true });
    if (record.kind === "request") requests.push(record.request);
    else complete = false;
  }
  return { requests, complete };
}
