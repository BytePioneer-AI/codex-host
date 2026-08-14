import { createTwoFilesPatch } from "diff";

import {
  parseHostUsage,
  type HarnessError,
  type HostFileChange,
  type HostThreadSnapshot,
  type HostToolOutput,
  type HostUsage,
  type TurnOutcome,
} from "@codexhost/harness-adapter";
import { jsonValueSchema, type JsonValue } from "@codexhost/shared-contracts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseArguments(value: unknown): JsonValue {
  if (typeof value !== "string") return {};
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : value;
  } catch {
    return value;
  }
}

export function contentText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) return "";
  return value.content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => (block as { text: string }).text)
    .join("");
}

export interface DeepSeekToolResult {
  callId: string;
  failed: boolean;
  output?: HostToolOutput;
}

export function projectToolResult(value: unknown, limit: number): DeepSeekToolResult | null {
  if (!isRecord(value) || !isRecord(value.source) || value.source.kind !== "tool") return null;
  const callId = value.source.callId;
  if (!nonBlankString(callId) || !Array.isArray(value.content)) return null;
  const resultBlocks = value.content.filter(
    (block) =>
      isRecord(block) &&
      block.type === "tool-result" &&
      block.toolCallId === callId &&
      Array.isArray(block.content),
  );
  if (resultBlocks.length === 0) return null;
  const text = resultBlocks
    .flatMap((block) => (block as { content: unknown[] }).content)
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => (block as { text: string }).text)
    .join("");
  const truncated = text.length > limit;
  return {
    callId,
    failed: resultBlocks.some((block) => block.isError === true),
    ...(text
      ? {
          output: {
            content: [{ type: "text", text: truncated ? text.slice(0, limit) : text }],
            ...(truncated ? { truncated: true } : {}),
          },
        }
      : {}),
  };
}

function validDiffPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

export function structuredDiffs(meta: unknown): HostFileChange[] | null {
  if (!isRecord(meta) || !Array.isArray(meta.diffs) || meta.diffs.length === 0) return null;
  const changes: HostFileChange[] = [];
  for (const candidate of meta.diffs) {
    if (
      !isRecord(candidate) ||
      !validDiffPath(candidate.path) ||
      (candidate.oldText !== null && typeof candidate.oldText !== "string") ||
      (candidate.newText !== null && typeof candidate.newText !== "string")
    ) {
      return null;
    }
    const oldText = candidate.oldText as string | null;
    const newText = candidate.newText as string | null;
    const kind = oldText === null ? "add" : newText === null ? "delete" : "update";
    const oldHeader = kind === "add" ? "/dev/null" : `a/${candidate.path}`;
    const newHeader = kind === "delete" ? "/dev/null" : `b/${candidate.path}`;
    const unifiedDiff = createTwoFilesPatch(
      oldHeader,
      newHeader,
      oldText ?? "",
      newText ?? "",
      "",
      "",
      { context: 3 },
    );
    changes.push({ path: candidate.path, kind, unifiedDiff });
  }
  return changes;
}

export function parseDeepSeekContextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function deepSeekUsageKey(data: Record<string, unknown>, fallback: string): string {
  return Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)
    ? `turn:${data.turn}:step:${data.step}`
    : fallback;
}

export function parseDeepSeekOutputTokensPerSecond(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const direct = [
    value.outputTokensPerSecond,
    value.tokensPerSecond,
    value.decodeTokensPerSecond,
  ].find((candidate) => typeof candidate === "number");
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
  const decodeTokens = nonNegativeSafeInteger(value.decodeTokens);
  const decodeMs = nonNegativeSafeInteger(value.decodeMs);
  if (decodeTokens === undefined || decodeMs === undefined || decodeMs === 0) return undefined;
  return (decodeTokens * 1_000) / decodeMs;
}

export function parseDeepSeekUsage(value: unknown, contextWindowTokens?: number): HostUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = nonNegativeSafeInteger(value.inputTokens);
  const cacheReadTokens = nonNegativeSafeInteger(value.cacheReadTokens);
  const cacheWriteTokens = nonNegativeSafeInteger(value.cacheWriteTokens);
  const outputTokens = nonNegativeSafeInteger(value.outputTokens);
  const reasoningTokens = nonNegativeSafeInteger(value.reasoningTokens);
  const windowTokens = parseDeepSeekContextWindow(contextWindowTokens);
  const billedInput = (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  const cacheHitRatePercent =
    inputTokens !== undefined && billedInput > 0
      ? ((cacheReadTokens ?? 0) / billedInput) * 100
      : undefined;
  try {
    return parseHostUsage({
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cachedInputTokens: cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteInputTokens: cacheWriteTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningOutputTokens: reasoningTokens } : {}),
      ...(cacheHitRatePercent !== undefined ? { cacheHitRatePercent } : {}),
      ...(windowTokens !== undefined
        ? { contextUsedTokens: billedInput, contextWindowTokens: windowTokens }
        : {}),
    });
  } catch {
    return null;
  }
}

const DEEPSEEK_USAGE_COUNTERS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const satisfies ReadonlyArray<keyof HostUsage>;

export function mergeDeepSeekUsage(current: HostUsage | null, next: HostUsage): HostUsage {
  const counters = Object.fromEntries(
    DEEPSEEK_USAGE_COUNTERS.flatMap((field) => {
      const value = (current?.[field] ?? 0) + (next[field] ?? 0);
      return current?.[field] !== undefined || next[field] !== undefined ? [[field, value]] : [];
    }),
  );
  const context =
    next.contextUsedTokens !== undefined && next.contextWindowTokens !== undefined
      ? {
          contextUsedTokens: next.contextUsedTokens,
          contextWindowTokens: next.contextWindowTokens,
        }
      : current?.contextUsedTokens !== undefined && current.contextWindowTokens !== undefined
        ? {
            contextUsedTokens: current.contextUsedTokens,
            contextWindowTokens: current.contextWindowTokens,
          }
        : {};
  return parseHostUsage({
    ...counters,
    ...context,
    ...(next.cacheHitRatePercent !== undefined
      ? { cacheHitRatePercent: next.cacheHitRatePercent }
      : current?.cacheHitRatePercent !== undefined
        ? { cacheHitRatePercent: current.cacheHitRatePercent }
        : {}),
    ...(next.outputTokensPerSecond !== undefined
      ? { outputTokensPerSecond: next.outputTokensPerSecond }
      : current?.outputTokensPerSecond !== undefined
        ? { outputTokensPerSecond: current.outputTokensPerSecond }
        : {}),
  });
}

export function projectTurnReason(value: unknown): {
  outcome: TurnOutcome;
  history: HostThreadSnapshot["turns"][number]["outcome"];
} {
  if (!isRecord(value) || typeof value.kind !== "string") {
    const error: HarnessError = {
      code: "protocolError",
      message: "DeepSeek Harness returned an invalid Turn outcome",
      retryable: false,
    };
    return { outcome: { status: "failed", error }, history: { status: "failed", error } };
  }
  if (value.kind === "completed" || value.kind === "max-tokens") {
    return { outcome: { status: "succeeded" }, history: { status: "succeeded" } };
  }
  if (value.kind === "aborted") {
    return {
      outcome: { status: "cancelled", reason: "Cancelled by user" },
      history: { status: "cancelled", reason: "Cancelled by user" },
    };
  }
  const error: HarnessError = {
    code: "nativeFailure",
    message:
      value.kind === "error" && isRecord(value.error) && typeof value.error.message === "string"
        ? value.error.message
        : `DeepSeek Harness Turn ended with '${value.kind}'`,
    retryable: false,
  };
  return { outcome: { status: "failed", error }, history: { status: "failed", error } };
}
