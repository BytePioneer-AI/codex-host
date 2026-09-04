import {
  type HostAgentMessageItem,
  type HarnessError,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostToolOutput,
  type HistoricalTurnOutcome,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeTurnRefSchema,
  type HarnessModelRef,
  type JsonValue,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import type { PenguinNativeModelRef } from "./model-catalog.js";

export interface PenguinSessionInfo {
  sessionId: string;
  projectId: string;
  agentId: string;
  provider: string;
  modelId: string;
  workspace?: string;
  approvalMode?: string;
  thinkingLevel?: string;
  status?: string;
  [key: string]: unknown;
}

export interface PenguinHistoryResponse {
  messages: unknown[];
  live?: unknown;
}

const penguinHarnessId = harnessIdSchema.parse("penguin");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromPayload(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.thinking === "string") return payload.thinking;
  if (typeof payload.content === "string") return payload.content;
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

function mainMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return !Array.isArray(value.origin) || value.origin.length === 0;
}

function messagePayload(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.payload) ? value.payload : null;
}

function messageType(value: unknown): string | null {
  return isRecord(value) && typeof value.type === "string" ? value.type : null;
}

function itemId(
  sessionId: string,
  messageIndex: number,
  kind: string,
): ReturnType<typeof hostItemIdSchema.parse> {
  return hostItemIdSchema.parse(`penguin-item-v1-${sessionId}-${messageIndex}-${kind}`);
}

function safeJsonValue(value: unknown, fallback: string): JsonValue {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function toolArguments(payload: Record<string, unknown>): JsonValue {
  if (typeof payload.arguments === "string") {
    try {
      return safeJsonValue(JSON.parse(payload.arguments), payload.arguments);
    } catch {
      return payload.arguments;
    }
  }
  return safeJsonValue(payload.arguments ?? {}, "{}");
}

function toolOutput(payload: Record<string, unknown>): HostToolOutput | undefined {
  const raw = payload.output ?? payload.content;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return { content: [{ type: "text", text: raw }] };
  try {
    return { content: [{ type: "text", text: JSON.stringify(raw) }] };
  } catch {
    return undefined;
  }
}

function nativeTurnRef(sessionId: string, index: number): NativeTurnRef {
  return nativeTurnRefSchema.parse({
    harnessId: penguinHarnessId,
    nativeSessionId: sessionId,
    nativeTurnKey: `message-${index}`,
    formatVersion: 1,
  });
}

function failure(message: string, retryable = false): HistoricalTurnOutcome {
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message,
      retryable,
    },
  };
}

function outcomeForMessages(messages: readonly unknown[]): HistoricalTurnOutcome {
  let sawAssistant = false;
  for (const message of messages) {
    if (!mainMessage(message)) continue;
    const payload = messagePayload(message);
    if (!payload) continue;
    if (
      messageType(message) === "model_msg" &&
      payload.type === "text" &&
      payload.role === "assistant"
    ) {
      sawAssistant = sawAssistant || textFromPayload(payload).length > 0;
    }
    if (messageType(message) !== "event_msg") continue;
    if (payload.type === "abort") {
      return { status: "cancelled", reason: "Penguin Task was aborted" };
    }
    if (payload.type === "request_end" && payload.status !== "completed") {
      return failure(
        typeof payload.error_message === "string" && payload.error_message.length > 0
          ? payload.error_message
          : typeof payload.message === "string" && payload.message.length > 0
            ? payload.message
            : "Penguin Task failed",
        payload.status === "retryable",
      );
    }
  }
  return sawAssistant
    ? { status: "succeeded" }
    : { status: "unknown", reason: "Penguin history has no Assistant terminal" };
}

function itemOutcome(outcome: HistoricalTurnOutcome): HostItemOutcome {
  if (outcome.status === "failed") return { status: "failed", error: outcome.error };
  if (outcome.status === "cancelled") {
    return { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  return { status: "succeeded" };
}

function turnInput(message: unknown): string {
  const payload = messagePayload(message);
  return payload ? textFromPayload(payload) : "";
}

function snapshotItems(
  messages: readonly unknown[],
  sessionId: string,
  turnOutcome: HistoricalTurnOutcome,
): HostItemSnapshot[] {
  const items: HostItemSnapshot[] = [];
  const toolItems = new Map<string, HostItemSnapshot>();
  for (const [index, message] of messages.entries()) {
    if (!mainMessage(message)) continue;
    const payload = messagePayload(message);
    const type = messageType(message);
    if (!payload) continue;
    if (type !== "model_msg") continue;
    if (payload.type === "thinking" && payload.role === "assistant") {
      const item: HostReasoningItem = {
        type: "reasoning",
        itemId: itemId(sessionId, index, "thinking"),
        text: textFromPayload(payload),
      };
      if (item.text.length > 0) items.push({ item, outcome: itemOutcome(turnOutcome) });
      continue;
    }
    if (payload.type === "text" && payload.role === "assistant") {
      const item: HostAgentMessageItem = {
        type: "agentMessage",
        itemId: itemId(sessionId, index, "text"),
        text: textFromPayload(payload),
      };
      if (item.text.length > 0) items.push({ item, outcome: itemOutcome(turnOutcome) });
      continue;
    }
    if (payload.type === "tool_call" && typeof payload.tool_call_id === "string") {
      const item: HostToolExecutionItem = {
        type: "toolExecution",
        itemId: itemId(sessionId, index, "tool"),
        toolName: typeof payload.name === "string" ? payload.name : "Penguin tool",
        arguments: toolArguments(payload),
      };
      const snapshot: HostItemSnapshot = { item, outcome: itemOutcome(turnOutcome) };
      items.push(snapshot);
      toolItems.set(payload.tool_call_id, snapshot);
      continue;
    }
    if (payload.type === "tool_call_output" && typeof payload.tool_call_id === "string") {
      const snapshot = toolItems.get(payload.tool_call_id);
      if (!snapshot || snapshot.item.type !== "toolExecution") continue;
      const output = toolOutput(payload);
      if (output) snapshot.item.output = output;
      if (payload.is_error === true || payload.isError === true) {
        snapshot.outcome = {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: "Penguin tool execution failed",
            retryable: false,
          },
        };
      }
    }
  }
  return items;
}

function historyMessages(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.messages)) return value.messages;
  return [];
}

export function projectPenguinHistory(
  value: PenguinHistoryResponse | unknown,
  session: PenguinSessionInfo,
  model: HarnessModelRef,
): HostThreadSnapshot {
  const messages = historyMessages(value);
  const turns: HostThreadSnapshot["turns"] = [];
  let currentUserIndex: number | null = null;
  for (const [index, message] of messages.entries()) {
    if (!mainMessage(message) || messageType(message) !== "model_msg") continue;
    const payload = messagePayload(message);
    if (payload?.type !== "text" || payload.role !== "user") continue;
    if (currentUserIndex !== null) {
      const turnMessages = messages.slice(currentUserIndex, index);
      const outcome = outcomeForMessages(turnMessages);
      turns.push({
        nativeTurnRef: nativeTurnRef(session.sessionId, currentUserIndex),
        input: [{ type: "text", text: turnInput(messages[currentUserIndex]) }],
        items: snapshotItems(turnMessages, session.sessionId, outcome),
        outcome,
        model,
      });
    }
    currentUserIndex = index;
  }
  if (currentUserIndex !== null) {
    const turnMessages = messages.slice(currentUserIndex);
    const outcome = outcomeForMessages(turnMessages);
    turns.push({
      nativeTurnRef: nativeTurnRef(session.sessionId, currentUserIndex),
      input: [{ type: "text", text: turnInput(messages[currentUserIndex]) }],
      items: snapshotItems(turnMessages, session.sessionId, outcome),
      outcome,
      model,
    });
  }
  return { turns };
}

export function modelFromPenguinSession(session: PenguinSessionInfo): PenguinNativeModelRef {
  if (session.provider.trim().length === 0 || session.modelId.trim().length === 0) {
    throw new Error("Penguin Session has an incomplete Model identity");
  }
  return { provider: session.provider, modelId: session.modelId };
}

export function errorFromPenguinHistory(message: string): HarnessError {
  return { code: "protocolError", message, retryable: false };
}
