import { randomUUID } from "node:crypto";

export type OmpJsonObject = Record<string, unknown>;

export type OmpNotification =
  | { type: "ready"; protocolVersion: number | null; supportedProtocolVersions: number[] }
  | { type: "agent_start" }
  | { type: "agent_end"; isTerminal: boolean; messages?: unknown[] }
  | { type: "message_start"; message: OmpJsonObject }
  | { type: "message_update"; message: OmpJsonObject; assistantMessageEvent: OmpJsonObject }
  | { type: "message_end"; message: OmpJsonObject }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "auto_compaction_start" }
  | { type: "auto_compaction_end"; aborted: boolean; errorMessage?: string }
  | { type: "subagent_lifecycle"; payload: OmpJsonObject }
  | { type: "subagent_progress"; payload: OmpJsonObject }
  | { type: "subagent_event"; payload: OmpJsonObject }
  | { type: "unknown"; payload: OmpJsonObject; parseError?: string };

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;

function isObject(value: unknown): value is OmpJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export class OmpFrameDecoder {
  #pending: {
    chunkId: string;
    count: number;
    byteLength: number;
    nextIndex: number;
    chunks: Buffer[];
    received: number;
  } | null = null;

  push(value: unknown): OmpJsonObject | null {
    if (!isObject(value)) throw new Error("OMP RPC frame must be a JSON object");
    if (value.type !== "rpc_chunk") {
      if (this.#pending) throw new Error("OMP RPC chunk sequence was interrupted");
      return value;
    }
    const chunkId = value.chunkId;
    const index = value.index;
    const count = value.count;
    const byteLength = value.byteLength;
    const data = value.data;
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      !Number.isInteger(byteLength) ||
      (index as number) < 0 ||
      (count as number) < 2 ||
      (index as number) >= (count as number) ||
      (byteLength as number) < MAX_FRAME_BYTES ||
      (byteLength as number) > MAX_REASSEMBLED_BYTES ||
      typeof data !== "string" ||
      data.length === 0
    )
      throw new Error("Invalid OMP RPC chunk metadata");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(data, "base64");
    } catch {
      throw new Error("Invalid OMP RPC chunk data");
    }
    if (bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES || bytes.toString("base64") !== data) {
      throw new Error("Invalid OMP RPC chunk data");
    }
    const chunkIndex = index as number;
    const chunkCount = count as number;
    const declaredByteLength = byteLength as number;
    if (!this.#pending) {
      if (chunkIndex !== 0) throw new Error("OMP RPC chunk sequence must start at index 0");
      this.#pending = {
        chunkId,
        count: chunkCount,
        byteLength: declaredByteLength,
        nextIndex: 0,
        chunks: [],
        received: 0,
      };
    }
    const pending = this.#pending;
    if (!pending) throw new Error("OMP RPC chunk state was lost");
    if (
      pending.chunkId !== chunkId ||
      pending.count !== chunkCount ||
      pending.byteLength !== declaredByteLength ||
      pending.nextIndex !== chunkIndex
    ) {
      throw new Error("OMP RPC chunk sequence mismatch");
    }
    pending.chunks.push(bytes);
    pending.received += bytes.length;
    pending.nextIndex += 1;
    if (pending.received > pending.byteLength)
      throw new Error("OMP RPC chunk sequence exceeds its declared length");
    if (pending.nextIndex < pending.count) return null;
    if (pending.received !== pending.byteLength)
      throw new Error("OMP RPC chunk sequence length mismatch");
    this.#pending = null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.concat(pending.chunks).toString("utf8"));
    } catch {
      throw new Error("Failed to decode reassembled OMP RPC frame");
    }
    if (!isObject(decoded)) throw new Error("Reassembled OMP RPC frame must be an object");
    return decoded;
  }
}

export function assistantMessageId(message: unknown): string {
  return isObject(message) &&
    typeof message.responseId === "string" &&
    message.responseId.length > 0
    ? message.responseId
    : "assistant";
}

export function assistantText(message: unknown): string {
  if (!isObject(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((item): item is OmpJsonObject => isObject(item) && item.type === "text")
    .map((item) => stringValue(item.text))
    .join("");
}

export function assistantThinking(message: unknown): string {
  if (!isObject(message) || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item): item is OmpJsonObject => isObject(item) && item.type === "thinking")
    .map((item) => stringValue(item.thinking))
    .join("");
}

export function parseOmpNotification(payload: OmpJsonObject): OmpNotification {
  switch (payload.type) {
    case "ready":
      return {
        type: "ready",
        protocolVersion:
          typeof payload.protocolVersion === "number" ? payload.protocolVersion : null,
        supportedProtocolVersions: Array.isArray(payload.supportedProtocolVersions)
          ? payload.supportedProtocolVersions.filter(
              (item): item is number => typeof item === "number",
            )
          : [],
      };
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return Array.isArray(payload.messages)
        ? {
            type: "agent_end",
            isTerminal: payload.isTerminal !== false,
            messages: payload.messages,
          }
        : { type: "agent_end", isTerminal: payload.isTerminal !== false };
    case "message_start":
      return { type: "message_start", message: isObject(payload.message) ? payload.message : {} };
    case "message_update":
      return {
        type: "message_update",
        message: isObject(payload.message) ? payload.message : {},
        assistantMessageEvent: isObject(payload.assistantMessageEvent)
          ? payload.assistantMessageEvent
          : {},
      };
    case "message_end":
      return { type: "message_end", message: isObject(payload.message) ? payload.message : {} };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: stringValue(payload.toolCallId, randomUUID()),
        toolName: stringValue(payload.toolName, "tool"),
        args: payload.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolCallId: stringValue(payload.toolCallId),
        toolName: stringValue(payload.toolName, "tool"),
        partialResult: payload.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: stringValue(payload.toolCallId),
        toolName: stringValue(payload.toolName, "tool"),
        result: payload.result,
        isError: payload.isError === true,
      };
    case "auto_compaction_start":
      return { type: "auto_compaction_start" };
    case "auto_compaction_end":
      return {
        type: "auto_compaction_end",
        aborted: payload.aborted === true,
        ...(typeof payload.errorMessage === "string" ? { errorMessage: payload.errorMessage } : {}),
      };
    case "subagent_lifecycle":
    case "subagent_progress":
    case "subagent_event":
      return {
        type: payload.type,
        payload: isObject(payload.payload) ? payload.payload : {},
      };
    default:
      return { type: "unknown", payload };
  }
}

export function textDeltaFromOmpNotification(
  notification: Extract<OmpNotification, { type: "message_update" }>,
): { messageId: string; delta: string } | null {
  const event = notification.assistantMessageEvent;
  if (event.type !== "text_delta" || typeof event.delta !== "string") return null;
  return { messageId: assistantMessageId(notification.message), delta: event.delta };
}

export function thinkingDeltaFromOmpNotification(
  notification: Extract<OmpNotification, { type: "message_update" }>,
): { messageId: string; delta: string } | null {
  const event = notification.assistantMessageEvent;
  if (event.type !== "thinking_delta" || typeof event.delta !== "string") return null;
  return { messageId: assistantMessageId(notification.message), delta: event.delta };
}
