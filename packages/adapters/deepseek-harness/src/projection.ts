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

export function parseDeepSeekUsage(value: unknown): HostUsage | null {
  if (!isRecord(value)) return null;
  try {
    return parseHostUsage({
      ...(value.inputTokens !== undefined ? { inputTokens: value.inputTokens } : {}),
      ...(value.outputTokens !== undefined ? { outputTokens: value.outputTokens } : {}),
      ...(value.cacheReadTokens !== undefined ? { cachedInputTokens: value.cacheReadTokens } : {}),
      ...(value.cacheWriteTokens !== undefined
        ? { cacheWriteInputTokens: value.cacheWriteTokens }
        : {}),
    });
  } catch {
    return null;
  }
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
