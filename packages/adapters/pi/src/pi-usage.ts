import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";

export type PiSessionStats = HostUsage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseData(
  response: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  if (!isRecord(response.data)) {
    throw new Error(`Pi RPC ${operation} response has no data`);
  }
  return response.data;
}

function contextUsage(
  value: unknown,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> {
  if (!isRecord(value)) throw new Error("Pi RPC context Usage is invalid");
  return parseHostUsage({
    contextUsedTokens: value.tokens,
    contextWindowTokens: value.contextWindow,
  });
}

export function parsePiSessionUsage(response: Record<string, unknown>): PiSessionStats {
  const data = responseData(response, "Session stats");
  const tokens = data.tokens;
  if (tokens !== undefined && !isRecord(tokens)) {
    throw new Error("Pi RPC Session stats tokens are invalid");
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

export function parsePiStateContextUsage(
  response: Record<string, unknown>,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null {
  const data = responseData(response, "state");
  return data.contextUsage === undefined ? null : contextUsage(data.contextUsage);
}

export function optionalPiStateContextUsage(
  value: unknown,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null {
  if (value === undefined) return null;
  try {
    return contextUsage(value);
  } catch {
    return null;
  }
}
