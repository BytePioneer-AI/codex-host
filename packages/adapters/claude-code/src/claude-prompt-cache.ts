import type { HostUsage } from "@codexhost/harness-adapter";

export type ClaudePromptCacheTtlSeconds = 300 | 3600;

export const CLAUDE_PROMPT_CACHE_5M_TTL_SECONDS: ClaudePromptCacheTtlSeconds = 300;
export const CLAUDE_PROMPT_CACHE_1H_TTL_SECONDS: ClaudePromptCacheTtlSeconds = 3600;

export interface ClaudePromptCacheHistory {
  lastResponseAtUnix?: number;
  ttlSeconds?: ClaudePromptCacheTtlSeconds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Resolves the prompt cache TTL from one Anthropic `usage` object's `cache_creation` split.
 * When both 5m and 1h writes are present, the shorter 5m TTL governs because once the 5m
 * breakpoint expires, the cached prefix after it is invalidated.
 */
export function claudePromptCacheTtlSeconds(
  usage: unknown,
): ClaudePromptCacheTtlSeconds | undefined {
  if (!isRecord(usage) || !isRecord(usage.cache_creation)) return undefined;
  const split = usage.cache_creation;
  if (isPositiveSafeInteger(split.ephemeral_5m_input_tokens)) {
    return CLAUDE_PROMPT_CACHE_5M_TTL_SECONDS;
  }
  if (isPositiveSafeInteger(split.ephemeral_1h_input_tokens)) {
    return CLAUDE_PROMPT_CACHE_1H_TTL_SECONDS;
  }
  return undefined;
}

/**
 * Main-session native timestamps and observed prompt cache TTL survive Renderer reloads and
 * Session reopening. Cache-read-only continuation turns refresh the server-side cache without
 * emitting new `cache_creation` writes, so the latest observed write TTL is inherited.
 */
export function claudePromptCacheFromMessages(
  messages: readonly unknown[],
): ClaudePromptCacheHistory {
  let lastResponseAtUnix: number | undefined;
  let ttlSeconds: ClaudePromptCacheTtlSeconds | undefined;
  let latestTtlTime: number | undefined;

  for (const entry of messages) {
    if (
      !isRecord(entry) ||
      entry.type !== "assistant" ||
      entry.isSidechain === true ||
      entry.parent_tool_use_id != null
    ) {
      continue;
    }
    const message = isRecord(entry.message) ? entry.message : null;
    if (message?.model === "<synthetic>") continue;

    if (typeof entry.timestamp !== "string") continue;
    const time = Math.floor(Date.parse(entry.timestamp) / 1000);
    if (!Number.isSafeInteger(time) || time < 0) continue;
    lastResponseAtUnix = Math.max(lastResponseAtUnix ?? 0, time);

    const entryTtl = claudePromptCacheTtlSeconds(message?.usage);
    if (entryTtl !== undefined && (latestTtlTime === undefined || time >= latestTtlTime)) {
      ttlSeconds = entryTtl;
      latestTtlTime = time;
    }
  }

  return {
    ...(lastResponseAtUnix !== undefined ? { lastResponseAtUnix } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  };
}

export function claudePromptCacheIndicators(
  accountCreditsSupported: boolean,
  lastResponseAtUnix: number | undefined,
  ttlSeconds: ClaudePromptCacheTtlSeconds | undefined,
): NonNullable<HostUsage["composerIndicators"]> {
  if (!accountCreditsSupported || lastResponseAtUnix === undefined || ttlSeconds === undefined) {
    return [];
  }
  return [
    {
      kind: "countdown",
      id: "prompt-cache",
      expiresAtUnix: lastResponseAtUnix + ttlSeconds,
      label: { en: "Prompt cache", "zh-CN": "提示词缓存" },
    },
  ];
}
