import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

const INLINE_MARKDOWN = "::codex-realtime-inline{}\n";
const inlineMarker = /^::codex-realtime-inline\{\}\r?\n/u;

export function externalVoiceContentText(text: string): string {
  return text.replace(inlineMarker, "");
}

function object(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function presentItem(item: JsonValue): JsonValue {
  if (!object(item) || item.type !== "agentMessage" || typeof item.text !== "string") return item;
  if (!item.text.trim() || inlineMarker.test(item.text)) return item;
  return { ...item, text: INLINE_MARKDOWN + item.text };
}

/** Desktop's native voice timeline discovers exact Markdown through this directive. */
export function presentExternalVoiceTurn(turn: JsonObject): JsonObject {
  if (!Array.isArray(turn.items)) return turn;
  return { ...turn, items: turn.items.map(presentItem) };
}

/** Presentation only: neither Harness history nor the speech context receives the directive. */
export function presentExternalVoiceMessage(message: JsonObject): JsonObject {
  const params = message.params;
  if (!object(params)) return message;
  if ((message.method === "item/started" || message.method === "item/completed") && params.item) {
    return { ...message, params: { ...params, item: presentItem(params.item) } };
  }
  if (
    (message.method === "turn/started" || message.method === "turn/completed") &&
    object(params.turn)
  ) {
    return { ...message, params: { ...params, turn: presentExternalVoiceTurn(params.turn) } };
  }
  return message;
}
