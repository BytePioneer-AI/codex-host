import {
  parseHostUsage,
  parseHostUsageRequest,
  type HostUsage,
  type HostUsageRequest,
} from "@codexhost/harness-adapter";

import { activeOmpEntries, type OmpSessionHistory } from "./omp-history.js";

export type OmpSessionStats = HostUsage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function optionalOmpCacheHitRatePercent(value: unknown): number | null {
  if (!isRecord(value) || value.role !== "assistant" || !isRecord(value.usage)) return null;
  const input = nonNegativeSafeInteger(value.usage.input);
  const cacheRead = nonNegativeSafeInteger(value.usage.cacheRead);
  const cacheWrite = nonNegativeSafeInteger(value.usage.cacheWrite);
  if (input === null || cacheRead === null || cacheWrite === null) return null;
  const promptTokens = input + cacheRead + cacheWrite;
  return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : null;
}

export function latestOmpCacheHitRatePercent(history: OmpSessionHistory): number | null {
  let latest: number | null = null;
  for (const entry of activeOmpEntries(history)) {
    if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
      latest = optionalOmpCacheHitRatePercent(entry.message);
    }
  }
  return latest;
}

function responseData(
  response: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  if (!isRecord(response.data)) {
    throw new Error(`Omp RPC ${operation} response has no data`);
  }
  return response.data;
}

function contextUsage(
  value: unknown,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> {
  if (!isRecord(value)) throw new Error("Omp RPC context Usage is invalid");
  return parseHostUsage({
    contextUsedTokens: value.tokens,
    contextWindowTokens: value.contextWindow,
  });
}

export function parseOmpSessionUsage(response: Record<string, unknown>): OmpSessionStats {
  const data = responseData(response, "Session stats");
  const tokens = data.tokens;
  if (tokens !== undefined && !isRecord(tokens)) {
    throw new Error("Omp RPC Session stats tokens are invalid");
  }
  return parseHostUsage({
    ...(isRecord(tokens) && tokens.input !== undefined ? { inputTokens: tokens.input } : {}),
    ...(isRecord(tokens) && tokens.cacheRead !== undefined
      ? { cachedInputTokens: tokens.cacheRead }
      : {}),
    ...(isRecord(tokens) && tokens.cacheWrite !== undefined
      ? { cacheWriteInputTokens: tokens.cacheWrite }
      : {}),
    ...(isRecord(tokens) && tokens.output !== undefined ? { outputTokens: tokens.output } : {}),
    ...(isRecord(tokens) && tokens.total !== undefined ? { totalTokens: tokens.total } : {}),
    ...(data.cost !== undefined ? { totalCostUsd: data.cost } : {}),
    ...(data.contextUsage !== undefined ? contextUsage(data.contextUsage) : {}),
  });
}

export function parseOmpStateContextUsage(
  response: Record<string, unknown>,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null {
  const data = responseData(response, "state");
  return data.contextUsage === undefined ? null : contextUsage(data.contextUsage);
}

export function optionalOmpStateContextUsage(
  value: unknown,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null {
  if (value === undefined) return null;
  try {
    return contextUsage(value);
  } catch {
    return null;
  }
}

/** A finished native assistant message observed on the RPC stream. */
export interface OmpUsageObservation {
  message: Record<string, unknown>;
  /** Adapter receive time of this message's first thinking, text or tool-call event. */
  startedAtMs: number | null;
  completedAtMs: number;
}

export type OmpUsageRecord = { kind: "request"; request: HostUsageRequest } | { kind: "missing" };

/**
 * One Omp assistant message is one model request. Omp reports input without cache reads and
 * writes, and output including reasoning; the request adds the cache back into input.
 * Returns null for non-assistant messages.
 */
export function ompUsageRecord(
  message: unknown,
  extra: { historical?: boolean; startedAtMs?: number | null; completedAtMs?: number } = {},
): OmpUsageRecord | null {
  if (!isRecord(message) || message.role !== "assistant") return null;
  const usage = isRecord(message.usage) ? message.usage : null;
  const input = nonNegativeSafeInteger(usage?.input);
  const output = nonNegativeSafeInteger(usage?.output);
  const requestId =
    typeof message.responseId === "string" && message.responseId.length > 0
      ? message.responseId
      : typeof message.timestamp === "number" && Number.isSafeInteger(message.timestamp)
        ? `t${message.timestamp}`
        : null;
  if (!usage || input === null || output === null || requestId === null) {
    return { kind: "missing" };
  }
  const cacheRead = nonNegativeSafeInteger(usage.cacheRead);
  const cacheWrite = nonNegativeSafeInteger(usage.cacheWrite);
  const reasoning = nonNegativeSafeInteger(usage.reasoningTokens ?? usage.reasoning);
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
        // Omp's provider is a configurable name, not a standard provider ID.
        ...(typeof message.model === "string" && message.model.length > 0
          ? { model: message.model }
          : {}),
        inputTokens: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
        ...(cacheRead !== null ? { cachedInputTokens: cacheRead } : {}),
        ...(cacheWrite !== null ? { cacheWriteInputTokens: cacheWrite } : {}),
        outputTokens: output,
        ...(reasoning !== null && reasoning <= output ? { reasoningOutputTokens: reasoning } : {}),
        ...(timed ? { startedAtMs: extra.startedAtMs, completedAtMs: extra.completedAtMs } : {}),
      }),
    };
  } catch {
    return { kind: "missing" };
  }
}

/** Every assistant request in the native history, across all branches. */
export function ompUsageHistory(history: OmpSessionHistory): {
  requests: HostUsageRequest[];
  complete: boolean;
} {
  const requests: HostUsageRequest[] = [];
  let complete = true;
  for (const entry of history.entries) {
    if (entry.type !== "message") continue;
    const record = ompUsageRecord(entry.message, { historical: true });
    if (record?.kind === "request") requests.push(record.request);
    else if (record?.kind === "missing") complete = false;
  }
  return { requests, complete };
}
