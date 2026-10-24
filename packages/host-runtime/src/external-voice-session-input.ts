import type { JsonObject } from "@codexhost/protocol-core";
import { externalVoiceContentText } from "./external-voice-presentation.js";

const MAX_MESSAGES = 32;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TOTAL_CHARS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userMessageText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter(isRecord)
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text.trim() : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function clip(text: string): string {
  return text.length <= MAX_MESSAGE_CHARS ? text : text.slice(0, MAX_MESSAGE_CHARS);
}

function liveMessage(role: "user" | "assistant", text: string): JsonObject {
  return {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text: clip(text) }],
  };
}

function messageChars(message: JsonObject): number {
  const content = message.content;
  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0].text !== "string") {
    return 0;
  }
  return content[0].text.length;
}

/** GPT-Live `session.initial_items` history from an existing External Thread's projected Turns. */
export function voiceSessionInputFromTurns(turns: readonly unknown[]): JsonObject[] {
  const messages: JsonObject[] = [];
  for (const turn of turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      if (!isRecord(item)) continue;
      if (item.type === "userMessage") {
        const text = userMessageText(item);
        if (text) messages.push(liveMessage("user", text));
      } else if (item.type === "agentMessage" && item.phase !== "commentary") {
        const text =
          typeof item.text === "string" ? externalVoiceContentText(item.text).trim() : "";
        if (text) messages.push(liveMessage("assistant", text));
      }
    }
  }
  const selected: JsonObject[] = [];
  let total = 0;
  for (const message of messages.slice(-MAX_MESSAGES).reverse()) {
    const size = messageChars(message);
    if (total + size > MAX_TOTAL_CHARS) break;
    total += size;
    selected.push(message);
  }
  return selected.reverse();
}
