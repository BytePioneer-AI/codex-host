import type { ClaudeTransportFailureKind, ClaudeTransportTurnResult } from "./transport.js";

const ABORTED_TERMINALS = new Set(["aborted_streaming", "aborted_tools"]);
const AUTHENTICATION_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textDelta(message: unknown): string | null {
  if (!isRecord(message) || message.type !== "stream_event" || !isRecord(message.event)) {
    return null;
  }
  const event = message.event;
  if (event.type !== "content_block_delta" || !isRecord(event.delta)) return null;
  return event.delta.type === "text_delta" && typeof event.delta.text === "string"
    ? event.delta.text
    : null;
}

function assistantText(message: unknown): string | null {
  if (!isRecord(message) || message.type !== "assistant" || !isRecord(message.message)) return null;
  const content = message.message.content;
  if (!Array.isArray(content)) return null;
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
}

function assistantError(message: unknown): string | null {
  return isRecord(message) && message.type === "assistant" && typeof message.error === "string"
    ? message.error
    : null;
}

function includesAuthenticationFailure(
  message: Record<string, unknown>,
  errors: string[],
): boolean {
  if (errors.some((error) => AUTHENTICATION_ERRORS.has(error))) return true;
  const text = [message.result, ...(Array.isArray(message.errors) ? message.errors : [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return (
    text.includes("not logged in") || text.includes("invalid api key") || text.includes("oauth")
  );
}

function failure(kind: ClaudeTransportFailureKind): ClaudeTransportTurnResult {
  return { status: "failed", kind };
}

export interface ClaudeNativeMessageResult {
  deltas: string[];
  terminal?: ClaudeTransportTurnResult;
}

export class ClaudeNativeTurnAccumulator {
  #assistantErrors: string[] = [];
  #cancelRequested = false;
  #completed = false;
  #publishedText = "";
  #textConflict = false;

  requestCancel(): void {
    this.#cancelRequested = true;
  }

  consume(message: unknown): ClaudeNativeMessageResult {
    if (this.#completed) return { deltas: [] };
    const deltas: string[] = [];
    const delta = textDelta(message);
    if (delta !== null && delta.length > 0) {
      this.#publishedText += delta;
      deltas.push(delta);
    }

    const error = assistantError(message);
    if (error !== null) this.#assistantErrors.push(error);

    const completeText = assistantText(message);
    if (completeText !== null && completeText.length > 0) {
      if (completeText.startsWith(this.#publishedText)) {
        const suffix = completeText.slice(this.#publishedText.length);
        if (suffix.length > 0) {
          this.#publishedText += suffix;
          deltas.push(suffix);
        }
      } else if (completeText !== this.#publishedText) {
        this.#textConflict = true;
      }
    }

    if (!isRecord(message) || message.type !== "result") return { deltas };
    this.#completed = true;
    const terminalReason =
      typeof message.terminal_reason === "string" ? message.terminal_reason : "missing";
    let terminal: ClaudeTransportTurnResult;
    if (this.#textConflict) {
      terminal = failure("textConflict");
    } else if (includesAuthenticationFailure(message, this.#assistantErrors)) {
      terminal = failure("authentication");
    } else if (this.#cancelRequested && ABORTED_TERMINALS.has(terminalReason)) {
      terminal = { status: "cancelled", reason: terminalReason };
    } else if (this.#cancelRequested) {
      terminal = failure("cancellationUnproven");
    } else if (
      message.subtype === "success" &&
      message.is_error === false &&
      (terminalReason === "completed" || terminalReason === "missing") &&
      this.#assistantErrors.length === 0
    ) {
      terminal = { status: "succeeded" };
    } else {
      terminal = failure("native");
    }
    return { deltas, terminal };
  }
}
