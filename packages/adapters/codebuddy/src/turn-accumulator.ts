import type {
  CodeBuddyAssistantMessage,
  CodeBuddyInitInfo,
  CodeBuddyStreamFrame,
  CodeBuddyTurnResult,
} from "./stream-protocol.js";
import { initInfoFromFrame } from "./stream-protocol.js";

export type CodeBuddyTurnProjection =
  | { kind: "init"; info: CodeBuddyInitInfo }
  | { kind: "text.delta"; delta: string }
  | { kind: "reasoning.delta"; delta: string }
  | { kind: "tool.started"; callId: string; toolName: string; input: unknown }
  | {
      kind: "tool.completed";
      callId: string;
      outputText: string | null;
      isError: boolean;
    }
  | { kind: "completed"; result: CodeBuddyTurnResult };

function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function toolResultEntries(message: CodeBuddyAssistantMessage): Array<{
  callId: string;
  outputText: string | null;
  isError: boolean;
}> {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const entries: Array<{ callId: string; outputText: string | null; isError: boolean }> = [];
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    if (typeof block.tool_use_id !== "string") continue;
    entries.push({
      callId: block.tool_use_id,
      outputText: toolResultText(block.content),
      isError: block.is_error === true,
    });
  }
  return entries;
}

/**
 * Translates one turn's stream frames into ordered turn projections. Text and
 * reasoning are streamed from `stream_event` deltas; finalized `assistant`
 * frames only contribute tool calls (with a text fallback when the CLI did not
 * stream deltas). The terminal `result` frame completes the turn.
 */
export class CodeBuddyTurnAccumulator {
  readonly #onProjection: (projection: CodeBuddyTurnProjection) => void;
  #sawTextDelta = false;

  constructor(onProjection: (projection: CodeBuddyTurnProjection) => void) {
    this.#onProjection = onProjection;
  }

  handleFrame(frame: CodeBuddyStreamFrame): void {
    const init = initInfoFromFrame(frame);
    if (init) {
      this.#onProjection({ kind: "init", info: init });
      return;
    }
    if (frame.type === "stream_event") {
      this.#handleStreamEvent(frame);
      return;
    }
    if (frame.type === "assistant" && frame.message) {
      this.#handleAssistantMessage(frame.message);
      return;
    }
    if (frame.type === "user" && frame.message) {
      for (const entry of toolResultEntries(frame.message)) {
        this.#onProjection({ kind: "tool.completed", ...entry });
      }
      return;
    }
    if (frame.type === "result") {
      this.#onProjection({ kind: "completed", result: turnResultFromFrame(frame) });
    }
  }

  #handleStreamEvent(frame: CodeBuddyStreamFrame): void {
    const event = frame.event;
    if (!event || event.type !== "content_block_delta") return;
    const delta = event.delta;
    if (!delta?.type) return;
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      this.#sawTextDelta = true;
      this.#onProjection({ kind: "text.delta", delta: delta.text });
      return;
    }
    if (
      delta.type === "thinking_delta" &&
      typeof delta.thinking === "string" &&
      delta.thinking.length > 0
    ) {
      this.#onProjection({ kind: "reasoning.delta", delta: delta.thinking });
    }
  }

  #handleAssistantMessage(message: CodeBuddyAssistantMessage): void {
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "tool_use") {
        this.#onProjection({
          kind: "tool.started",
          callId: block.id,
          toolName: block.name,
          input: block.input,
        });
      } else if (block.type === "text" && !this.#sawTextDelta && block.text.length > 0) {
        // Fallback for CLI builds that skip stream_event text deltas.
        this.#onProjection({ kind: "text.delta", delta: block.text });
      }
    }
  }
}

function turnResultFromFrame(frame: CodeBuddyStreamFrame): CodeBuddyTurnResult {
  const isError = frame.is_error === true || frame.subtype === "error_during_execution";
  return {
    outcome: isError ? "failed" : "succeeded",
    is_error: isError,
    resultText: typeof frame.result === "string" ? frame.result : "",
    totalCostUsd: typeof frame.total_cost_usd === "number" ? frame.total_cost_usd : null,
    usage: frame.usage ?? null,
    modelUsage: frame.modelUsage ?? {},
    meta: frame._meta ?? null,
    sessionId: typeof frame.session_id === "string" ? frame.session_id : null,
  };
}
