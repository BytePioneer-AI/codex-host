import type { JsonRpcRequest } from "@codexhost/shared-contracts";

export interface DecodedThreadInjectItemsRequest {
  threadId: string;
  /** Text of each injected user message, in order. */
  texts: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Text-only user messages from `thread/inject_items`, such as Desktop's Side Chat boundary.
 * Any other item shape is rejected: an External Harness could not honor it.
 */
export function decodeThreadInjectItemsRequest(
  request: JsonRpcRequest,
): DecodedThreadInjectItemsRequest | null {
  if (request.method !== "thread/inject_items") return null;
  if (!isRecord(request.params)) throw new Error("thread/inject_items params must be an object");
  const { threadId, items } = request.params;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("thread/inject_items params.threadId must be non-empty text");
  }
  if (!Array.isArray(items)) throw new Error("thread/inject_items params.items must be an array");
  const texts = items.flatMap((item, index) => {
    if (!isRecord(item) || item.type !== "message" || item.role !== "user") {
      throw new Error(`thread/inject_items items[${index}] must be a user message`);
    }
    if (!Array.isArray(item.content)) {
      throw new Error(`thread/inject_items items[${index}].content must be an array`);
    }
    const text = item.content
      .map((part, partIndex) => {
        if (
          !isRecord(part) ||
          (part.type !== "input_text" && part.type !== "text") ||
          typeof part.text !== "string"
        ) {
          throw new Error(`thread/inject_items items[${index}].content[${partIndex}] must be text`);
        }
        return part.text;
      })
      .join("\n");
    return text.length > 0 ? [text] : [];
  });
  return { threadId, texts };
}
