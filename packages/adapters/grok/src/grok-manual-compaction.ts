export function isGrokCompactMethodNotFound(error: unknown): boolean {
  if (isRecord(error) && error.code === -32601) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /method not found/iu.test(message);
}
export const GROK_COMPACT_CONVERSATION_METHOD = "x.ai/compact_conversation";
export const GROK_COMPACT_CONVERSATION_FALLBACK_METHOD = "_x.ai/compact_conversation";

export interface GrokCompactConversationParams {
  sessionId: string;
  userContext?: string;
}

export interface GrokCompactResult {
  outcome: "succeeded" | "cancelled" | "failed";
  tokensBefore?: number;
  tokensAfter?: number;
  contextWindowTokens?: number;
  errorMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalErrorMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildGrokCompactConversationParams(
  params: GrokCompactConversationParams,
): GrokCompactConversationParams {
  return {
    sessionId: params.sessionId,
    ...(params.userContext !== undefined ? { userContext: params.userContext } : {}),
  };
}

export function parseGrokCompactResult(value: unknown, cancelled = false): GrokCompactResult {
  if (cancelled) return { outcome: "cancelled" };
  if (!isRecord(value)) return { outcome: "succeeded" };

  const tokensBefore = optionalNonNegativeInt(value.tokensBefore ?? value.tokens_before);
  const tokensAfter = optionalNonNegativeInt(value.tokensAfter ?? value.tokens_after);
  const contextWindowTokens = optionalNonNegativeInt(
    value.contextWindowTokens ?? value.context_window,
  );
  const errorMessage = optionalErrorMessage(
    value.errorMessage ?? value.error_message ?? value.message,
  );
  const outcome = value.outcome;
  if (outcome === "cancelled" || value.aborted === true) {
    return {
      outcome: "cancelled",
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    };
  }
  if (outcome === "failed" || value.success === false || errorMessage) {
    return {
      outcome: "failed",
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    };
  }
  return {
    outcome: "succeeded",
    ...(tokensBefore !== undefined ? { tokensBefore } : {}),
    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}
