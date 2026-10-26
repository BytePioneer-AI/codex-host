import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type { HarnessSessionUsageObservation } from "@codexhost/harness-adapter/plugin";
import { object } from "./counters.js";

const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Codex input already includes cache; output already includes reasoning. */
export function tokenSnapshot(value: unknown): HostUsage | null {
  const token = object(value);
  if (!token) return null;
  const total = object(token.total);
  const last = object(token.last);
  const result: HostUsage = {};
  for (const field of [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const) {
    const n = integer(total?.[field]);
    if (n !== undefined) result[field] = n;
  }
  const used = integer(last?.totalTokens);
  const window = integer(token.modelContextWindow);
  if (used !== undefined && window !== undefined && window > 0) {
    result.contextUsedTokens = used;
    result.contextWindowTokens = window;
  }
  const input = integer(last?.inputTokens);
  const cached = integer(last?.cachedInputTokens);
  if (input && cached !== undefined && cached <= input)
    result.cacheHitRatePercent = (cached / input) * 100;
  if (result.inputTokens && result.cachedInputTokens !== undefined) {
    result.sessionCacheUsage = {
      inputTokens: result.inputTokens,
      cachedInputTokens: result.cachedInputTokens,
    };
  }
  try {
    return Object.keys(result).length ? parseHostUsage(result) : null;
  } catch {
    return null;
  }
}

export function observeSessionUsage(message: unknown): HarnessSessionUsageObservation | null {
  const frame = object(message);
  const params = object(frame?.params);
  if (!params || typeof params.threadId !== "string" || !params.threadId) return null;
  const sessionId = params.threadId;
  if (frame?.method === "thread/tokenUsage/updated") {
    const usage = tokenSnapshot(params.tokenUsage);
    return usage ? { sessionId, usage } : null;
  }
  if (frame?.method === "turn/started" || frame?.method === "turn/completed") {
    const turn = object(params.turn);
    return typeof turn?.id === "string" && turn.id
      ? {
          sessionId,
          turn: { id: turn.id, phase: frame.method === "turn/started" ? "started" : "completed" },
        }
      : null;
  }
  if (typeof params.turnId !== "string" || !params.turnId) return null;
  if (
    [
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "item/reasoning/summaryTextDelta",
    ].includes(String(frame?.method)) &&
    typeof params.delta === "string" &&
    params.delta.length > 0
  ) {
    return { sessionId, turn: { id: params.turnId, phase: "output" } };
  }
  return null;
}

/** Legacy rollout token_count uses snake_case, unlike app-server notifications. */
export function rolloutTokenSnapshot(info: unknown): HostUsage | null {
  const record = object(info);
  if (!record) return null;
  const convert = (value: unknown) => {
    const u = object(value);
    return (
      u && {
        totalTokens: u.total_tokens,
        inputTokens: u.input_tokens,
        cachedInputTokens: u.cached_input_tokens,
        cacheWriteInputTokens: u.cache_write_input_tokens,
        outputTokens: u.output_tokens,
        reasoningOutputTokens: u.reasoning_output_tokens,
      }
    );
  };
  return tokenSnapshot({
    total: convert(record.total_token_usage),
    last: convert(record.last_token_usage),
    modelContextWindow: record.model_context_window,
  });
}
