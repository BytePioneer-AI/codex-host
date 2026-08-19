export const GROK_SESSION_UPDATE_EXTENSION_METHODS = [
  "_x.ai/session/update",
  "x.ai/session_notification",
] as const;

export type GrokCompactionOutcome = "succeeded" | "cancelled" | "failed";

export type GrokCompactionTransportEvent =
  | {
      type: "compaction.started";
      tokensUsed?: number;
      contextWindowTokens?: number;
    }
  | {
      type: "compaction.completed";
      outcome: GrokCompactionOutcome;
      tokensBefore?: number;
      tokensAfter?: number;
      contextWindowTokens?: number;
      errorMessage?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function firstPresent(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function optionalErrorMessage(record: Record<string, unknown>): string | undefined {
  const value = firstPresent(record, ["errorMessage", "error_message", "message"]);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isGrokExtensionSessionUpdateMethod(method: string): boolean {
  return (GROK_SESSION_UPDATE_EXTENSION_METHODS as readonly string[]).includes(method);
}

export function grokCompactionEventFromUpdate(
  update: unknown,
): GrokCompactionTransportEvent | null {
  if (!isRecord(update) || typeof update.sessionUpdate !== "string") return null;
  const tokensUsed = optionalNonNegativeInt(firstPresent(update, ["tokensUsed", "tokens_used"]));
  const contextWindowTokens = optionalNonNegativeInt(
    firstPresent(update, ["contextWindowTokens", "contextWindow", "context_window"]),
  );
  const tokensBefore = optionalNonNegativeInt(
    firstPresent(update, ["tokensBefore", "tokens_before"]),
  );
  const tokensAfter = optionalNonNegativeInt(firstPresent(update, ["tokensAfter", "tokens_after"]));
  if (update.sessionUpdate === "auto_compact_started") {
    return {
      type: "compaction.started",
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    };
  }
  if (update.sessionUpdate === "auto_compact_completed") {
    return {
      type: "compaction.completed",
      outcome: "succeeded",
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    };
  }
  if (update.sessionUpdate === "auto_compact_failed") {
    const errorMessage = optionalErrorMessage(update);
    return {
      type: "compaction.completed",
      outcome: "failed",
      ...(errorMessage ? { errorMessage } : {}),
    };
  }
  if (update.sessionUpdate === "auto_compact_cancelled") {
    return { type: "compaction.completed", outcome: "cancelled" };
  }
  return null;
}
