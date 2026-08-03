import { jsonValueSchema } from "@codexhost/shared-contracts";

import { parseClaudeNativeFileChange } from "./file-change.js";
import type {
  ClaudeTransportFailureKind,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
} from "./transport.js";

const ABORTED_TERMINALS = new Set(["aborted_streaming", "aborted_tools"]);
const AUTHENTICATION_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);

type ClaudeNativeEvent = Exclude<
  ClaudeTurnEvent,
  { type: "interaction.requested" | "interaction.closed" }
>;

interface AssistantMessageState {
  completed: boolean;
  reasoning: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeUuid(message: Record<string, unknown>): string | null {
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : null;
}

function assistantContent(message: Record<string, unknown>): unknown[] | null {
  if (message.type !== "assistant" || !isRecord(message.message)) return null;
  return Array.isArray(message.message.content) ? message.message.content : null;
}

function assistantText(message: Record<string, unknown>): string | null {
  const content = assistantContent(message);
  if (!content) return null;
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
}

function assistantReasoning(message: Record<string, unknown>): string | null {
  const content = assistantContent(message);
  if (!content) return null;
  const blocks = content.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && block.type === "thinking" && typeof block.thinking === "string",
  );
  return blocks.length > 0 ? blocks.map((block) => block.thinking as string).join("") : null;
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

function resultText(content: unknown, nativeResult: unknown): string | undefined {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .flatMap((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("");
  }
  if (text.length > 0) return text;
  if (!isRecord(nativeResult)) return undefined;
  const stdout = typeof nativeResult.stdout === "string" ? nativeResult.stdout : "";
  const stderr = typeof nativeResult.stderr === "string" ? nativeResult.stderr : "";
  const combined = stdout + stderr;
  return combined.length > 0 ? combined : undefined;
}

export interface ClaudeNativeMessageResult {
  events: ClaudeNativeEvent[];
  terminal?: ClaudeTransportTurnResult;
}

export class ClaudeNativeTurnAccumulator {
  #activeStreamMessageId: string | null = null;
  #assistantErrors: string[] = [];
  #cancelRequested = false;
  #completed = false;
  #completedToolIds = new Set<string>();
  #messageOrdinal = 0;
  #messages = new Map<string, AssistantMessageState>();
  #protocolConflict = false;
  #reasoningConflict = false;
  #textConflict = false;
  #tools = new Map<string, string>();

  requestCancel(): void {
    this.#cancelRequested = true;
  }

  consume(message: unknown): ClaudeNativeMessageResult {
    if (this.#completed || !isRecord(message)) return { events: [] };
    const events: ClaudeNativeEvent[] = [];

    if (message.type === "stream_event" && isRecord(message.event)) {
      this.#consumeStreamEvent(message, events);
    } else if (message.type === "tool_progress") {
      this.#consumeToolProgress(message, events);
    }

    const error = assistantError(message);
    if (error !== null) this.#assistantErrors.push(error);

    if (message.type === "assistant") {
      this.#consumeAssistantMessage(message, events);
    } else if (message.type === "user") {
      this.#consumeToolResults(message, events);
    }

    if (message.type !== "result") return { events };
    this.#completed = true;
    const terminalReason =
      typeof message.terminal_reason === "string" ? message.terminal_reason : "missing";
    const nativeSuccess =
      message.subtype === "success" &&
      message.is_error === false &&
      (terminalReason === "completed" || terminalReason === "missing") &&
      this.#assistantErrors.length === 0;
    if (nativeSuccess && this.#tools.size > 0) this.#protocolConflict = true;

    let terminal: ClaudeTransportTurnResult;
    if (this.#protocolConflict) {
      terminal = failure("protocol");
    } else if (this.#reasoningConflict) {
      terminal = failure("reasoningConflict");
    } else if (this.#textConflict) {
      terminal = failure("textConflict");
    } else if (includesAuthenticationFailure(message, this.#assistantErrors)) {
      terminal = failure("authentication");
    } else if (this.#cancelRequested && ABORTED_TERMINALS.has(terminalReason)) {
      terminal = { status: "cancelled", reason: terminalReason };
    } else if (this.#cancelRequested) {
      terminal = failure("cancellationUnproven");
    } else if (nativeSuccess) {
      terminal = { status: "succeeded" };
    } else {
      terminal = failure("native");
    }
    return { events, terminal };
  }

  #consumeStreamEvent(message: Record<string, unknown>, events: ClaudeNativeEvent[]): void {
    const event = message.event;
    if (!isRecord(event)) return;
    const messageId = this.#streamMessageId(message, event);
    const state = this.#messageState(messageId);
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) return;
    if (state.completed) {
      if (event.delta.type === "thinking_delta") this.#reasoningConflict = true;
      if (event.delta.type === "text_delta") this.#textConflict = true;
      return;
    }
    if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
      if (event.delta.text.length === 0) return;
      state.text += event.delta.text;
      events.push({ type: "text.delta", messageId, delta: event.delta.text });
      return;
    }
    if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
      if (event.delta.thinking.length === 0) return;
      state.reasoning += event.delta.thinking;
      events.push({ type: "reasoning.delta", messageId, delta: event.delta.thinking });
    }
  }

  #consumeAssistantMessage(message: Record<string, unknown>, events: ClaudeNativeEvent[]): void {
    const messageId = this.#activeStreamMessageId ?? nativeUuid(message) ?? this.#nextMessageId();
    const state = this.#messageState(messageId);
    if (state.completed) return;

    const completeReasoning = assistantReasoning(message);
    if (completeReasoning !== null) {
      if (completeReasoning.startsWith(state.reasoning)) {
        const suffix = completeReasoning.slice(state.reasoning.length);
        if (suffix.length > 0) {
          state.reasoning += suffix;
          events.push({ type: "reasoning.delta", messageId, delta: suffix });
        }
      } else if (completeReasoning !== state.reasoning) {
        this.#reasoningConflict = true;
      }
    }
    if (state.reasoning.length > 0 && !this.#reasoningConflict) {
      events.push({ type: "reasoning.completed", messageId });
    }

    const completeText = assistantText(message);
    if (completeText !== null && completeText.length > 0) {
      if (completeText.startsWith(state.text)) {
        const suffix = completeText.slice(state.text.length);
        if (suffix.length > 0) {
          state.text += suffix;
          events.push({ type: "text.delta", messageId, delta: suffix });
        }
      } else if (completeText !== state.text) {
        this.#textConflict = true;
      }
    }

    for (const block of assistantContent(message) ?? []) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const argumentsResult = jsonValueSchema.safeParse(block.input);
      if (
        typeof block.id !== "string" ||
        block.id.length === 0 ||
        typeof block.name !== "string" ||
        block.name.length === 0 ||
        !argumentsResult.success ||
        this.#tools.has(block.id) ||
        this.#completedToolIds.has(block.id)
      ) {
        this.#protocolConflict = true;
        continue;
      }
      this.#tools.set(block.id, block.name);
      events.push({
        type: "tool.started",
        callId: block.id,
        toolName: block.name,
        arguments: argumentsResult.data,
      });
    }

    if (!this.#protocolConflict && !this.#reasoningConflict && !this.#textConflict) {
      events.push({ type: "message.completed", messageId });
    }
    state.completed = true;
    if (this.#activeStreamMessageId === messageId) this.#activeStreamMessageId = null;
  }

  #consumeToolProgress(message: Record<string, unknown>, events: ClaudeNativeEvent[]): void {
    const callId = message.tool_use_id;
    const elapsedSeconds = message.elapsed_time_seconds;
    if (
      typeof callId !== "string" ||
      !this.#tools.has(callId) ||
      typeof elapsedSeconds !== "number" ||
      !Number.isFinite(elapsedSeconds) ||
      elapsedSeconds < 0
    ) {
      this.#protocolConflict = true;
      return;
    }
    events.push({ type: "tool.progress", callId, elapsedMs: Math.round(elapsedSeconds * 1_000) });
  }

  #consumeToolResults(message: Record<string, unknown>, events: ClaudeNativeEvent[]): void {
    if (!isRecord(message.message) || !Array.isArray(message.message.content)) return;
    const resultBlocks = message.message.content.filter(
      (block): block is Record<string, unknown> => isRecord(block) && block.type === "tool_result",
    );
    if (resultBlocks.length === 0) return;
    if (resultBlocks.length > 1 && message.tool_use_result !== undefined) {
      this.#protocolConflict = true;
    }
    for (const block of resultBlocks) {
      const callId = block.tool_use_id;
      if (typeof callId !== "string" || callId.length === 0) {
        this.#protocolConflict = true;
        continue;
      }
      const toolName = this.#tools.get(callId);
      if (!toolName || this.#completedToolIds.has(callId)) {
        this.#protocolConflict = true;
        continue;
      }
      if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
        this.#protocolConflict = true;
        continue;
      }
      this.#tools.delete(callId);
      this.#completedToolIds.add(callId);
      const isError = block.is_error === true;
      const nativeResult = resultBlocks.length === 1 ? message.tool_use_result : undefined;
      const outputText = resultText(block.content, nativeResult);
      const fileChange = isError ? null : parseClaudeNativeFileChange(toolName, nativeResult);
      events.push({
        type: "tool.completed",
        callId,
        toolName,
        ...(outputText ? { outputText } : {}),
        isError,
        ...(fileChange ? { fileChange } : {}),
      });
    }
  }

  #streamMessageId(message: Record<string, unknown>, event: Record<string, unknown>): string {
    if (this.#activeStreamMessageId) return this.#activeStreamMessageId;
    if (
      event.type === "message_start" &&
      isRecord(event.message) &&
      typeof event.message.id === "string" &&
      event.message.id.length > 0
    ) {
      this.#activeStreamMessageId = event.message.id;
      return event.message.id;
    }
    this.#activeStreamMessageId = nativeUuid(message) ?? this.#nextMessageId();
    return this.#activeStreamMessageId;
  }

  #messageState(messageId: string): AssistantMessageState {
    const existing = this.#messages.get(messageId);
    if (existing) return existing;
    const created = { completed: false, reasoning: "", text: "" };
    this.#messages.set(messageId, created);
    return created;
  }

  #nextMessageId(): string {
    this.#messageOrdinal += 1;
    return `claude-assistant-${this.#messageOrdinal}`;
  }
}
