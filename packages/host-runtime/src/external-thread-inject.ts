import type { JsonObject } from "@codexhost/protocol-core";

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode the text-only message items that Codex uses to establish Side Chat context.
 *
 * External Harness sessions do not expose Codex's raw item-history mutation API. The Host
 * therefore keeps these messages as pending reference context and combines them with the first
 * real Turn input. Rejecting other item shapes avoids acknowledging context that would be lost.
 */
export function decodeExternalThreadInjectedText(params: JsonObject): string[] {
  if (!Array.isArray(params.items)) {
    throw new Error("thread/inject_items params.items must be an array");
  }
  const texts: string[] = [];
  for (const [index, item] of params.items.entries()) {
    if (!isRecord(item) || item.type !== "message" || item.role !== "user") {
      throw new Error(`thread/inject_items item ${index} must be a user message`);
    }
    if (!Array.isArray(item.content)) {
      throw new Error(`thread/inject_items item ${index}.content must be an array`);
    }
    const text = item.content
      .map((part, partIndex) => {
        if (
          !isRecord(part) ||
          (part.type !== "input_text" && part.type !== "text") ||
          typeof part.text !== "string"
        ) {
          throw new Error(
            `thread/inject_items item ${index}.content[${partIndex}] must be text input`,
          );
        }
        return part.text;
      })
      .join("\n");
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

export function appendExternalThreadInjectedText(
  pending: string[],
  texts: readonly string[],
): void {
  for (const text of texts) {
    if (!pending.includes(text)) pending.push(text);
  }
}

export function combineExternalThreadInjectedText(
  pending: readonly string[],
  text: string,
): string {
  if (pending.length === 0) return text;
  return [...pending, text].join("\n\n");
}
