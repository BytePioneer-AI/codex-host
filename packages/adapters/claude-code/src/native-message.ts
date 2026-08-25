import { jsonValueSchema } from "@codexhost/shared-contracts";

import { parseClaudeNativeFileChange } from "./file-change.js";
import type {
  ClaudeTransportFailureKind,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
} from "./transport.js";

const ABORTED_TERMINALS = new Set(["aborted_streaming", "aborted_tools"]);
const AUTHENTICATION_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task", "SendMessage"]);
const SUBAGENT_DESCRIPTION_LIMIT = 500;
const SUBAGENT_SUMMARY_LIMIT = 2_000;

type ClaudeNativeEvent = Exclude<
  ClaudeTurnEvent,
  { type: "interaction.requested" | "interaction.closed" }
>;

interface AssistantMessageState {
  completed: boolean;
  reasoning: string;
  text: string;
}

interface ActiveNativeTool {
  name: string;
  subagent: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeUuid(message: Record<string, unknown>): string | null {
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : null;
}

function parentToolUseId(message: Record<string, unknown>): string | null {
  return typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.length > 0
    ? message.parent_tool_use_id
    : null;
}

function assistantNativeMessageId(message: Record<string, unknown>): string | null {
  if (!isRecord(message.message)) return null;
  return typeof message.message.id === "string" && message.message.id.length > 0
    ? message.message.id
    : null;
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

function assistantError(message: unknown): string | null {
  return isRecord(message) && message.type === "assistant" && typeof message.error === "string"
    ? message.error
    : null;
}

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, limit);
}

function subagentDescription(argumentsValue: unknown, toolName: string): string {
  if (!isRecord(argumentsValue)) return `${toolName} delegation`;
  return (
    boundedString(argumentsValue.description, SUBAGENT_DESCRIPTION_LIMIT) ??
    boundedString(argumentsValue.summary, SUBAGENT_DESCRIPTION_LIMIT) ??
    boundedString(argumentsValue.name, SUBAGENT_DESCRIPTION_LIMIT) ??
    `${toolName} delegation`
  );
}

function subagentPrompt(argumentsValue: unknown): string | undefined {
  if (!isRecord(argumentsValue)) return undefined;
  return boundedString(argumentsValue.prompt ?? argumentsValue.message, SUBAGENT_SUMMARY_LIMIT);
}

function subagentRole(argumentsValue: unknown): string | undefined {
  if (!isRecord(argumentsValue)) return undefined;
  return boundedString(
    argumentsValue.subagent_type ?? argumentsValue.agent_type,
    SUBAGENT_DESCRIPTION_LIMIT,
  );
}

function subagentBackground(argumentsValue: unknown): boolean {
  return isRecord(argumentsValue) && argumentsValue.run_in_background === true;
}

function targetedSubagentId(argumentsValue: unknown): string | undefined {
  if (!isRecord(argumentsValue)) return undefined;
  return boundedString(
    argumentsValue.to ?? argumentsValue.recipient ?? argumentsValue.agentId,
    SUBAGENT_DESCRIPTION_LIMIT,
  );
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

function nativeSubagentId(
  nativeResult: unknown,
  outputText: string | undefined,
): string | undefined {
  if (isRecord(nativeResult)) {
    const structured = boundedString(
      nativeResult.agentId ?? nativeResult.agent_id ?? nativeResult.task_id,
      SUBAGENT_DESCRIPTION_LIMIT,
    );
    if (structured) return structured;
  }
  return boundedString(
    /agentId:\s*([A-Za-z0-9_-]+)/u.exec(outputText ?? "")?.[1],
    SUBAGENT_DESCRIPTION_LIMIT,
  );
}

function subagentContinuesInBackground(
  nativeResult: unknown,
  outputText: string | undefined,
): boolean {
  if (isRecord(nativeResult)) {
    if (nativeResult.isAsync === true || nativeResult.is_async === true) return true;
    if (nativeResult.status === "async_launched") return true;
  }
  return outputText?.includes("The agent is working in the background.") ?? false;
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

function taskStatus(
  value: unknown,
): Extract<ClaudeNativeEvent, { type: "subagent.updated" }>["status"] | null {
  switch (value) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "interrupted";
    default:
      return null;
  }
}

export interface ClaudeNativeMessageResult {
  events: ClaudeNativeEvent[];
  terminal?: ClaudeTransportTurnResult;
}

export class ClaudeNativeTurnAccumulator {
  #activeRootStreamMessageId: string | null = null;
  #assistantErrors: string[] = [];
  #cancelRequested = false;
  #compactionState: "idle" | "active" | "settled" = "idle";
  #completed = false;
  #completedToolIds = new Set<string>();
  #messageOrdinal = 0;
  #messages = new Map<string, AssistantMessageState>();
  #protocolConflict = false;
  #textConflict = false;
  #tools = new Map<string, ActiveNativeTool>();

  requestCancel(): void {
    this.#cancelRequested = true;
  }

  consume(message: unknown): ClaudeNativeMessageResult {
    if (this.#completed || !isRecord(message)) return { events: [] };
    const events: ClaudeNativeEvent[] = [];

    this.#consumeTaskLifecycle(message, events);
    const parentCallId = parentToolUseId(message);
    const nested = parentCallId !== null;
    if (
      parentCallId &&
      this.#tools.get(parentCallId)?.subagent === true &&
      (message.type === "assistant" || message.type === "user")
    ) {
      events.push({ type: "subagent.transcript.changed", callId: parentCallId });
    }
    if (!nested) this.#consumeCompaction(message, events);

    if (message.type === "stream_event" && isRecord(message.event)) {
      if (!nested) this.#consumeStreamEvent(message, events);
    } else if (message.type === "tool_progress") {
      this.#consumeToolProgress(message, events);
    }

    if (!nested) {
      const error = assistantError(message);
      if (error !== null) this.#assistantErrors.push(error);
    }

    if (message.type === "assistant") {
      if (!nested) this.#consumeAssistantMessage(message, events);
    } else if (message.type === "user") {
      this.#consumeToolResults(message, events, nested);
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

  #consumeCompaction(message: Record<string, unknown>, events: ClaudeNativeEvent[]): void {
    if (message.type !== "system") return;
    if (message.subtype === "status") {
      if (message.status === "compacting" && this.#compactionState !== "active") {
        this.#compactionState = "active";
        events.push({ type: "compaction.started" });
      }
      if (message.compact_result === "success" || message.compact_result === "failed") {
        if (this.#compactionState === "settled") return;
        if (this.#compactionState === "idle") events.push({ type: "compaction.started" });
        this.#compactionState = "settled";
        events.push({
          type: "compaction.completed",
          outcome: message.compact_result === "success" ? "succeeded" : "failed",
        });
      }
      return;
    }
    if (message.subtype !== "compact_boundary" || this.#compactionState === "settled") return;
    if (this.#compactionState === "idle") events.push({ type: "compaction.started" });
    this.#compactionState = "settled";
    events.push({ type: "compaction.completed", outcome: "succeeded" });
  }

  #consumeTaskLifecycle(message: Record<string, unknown>, events: ClaudeNativeEvent[]): void {
    if (message.type !== "system") return;
    const callId = typeof message.tool_use_id === "string" ? message.tool_use_id : null;
    if (!callId || !this.#tools.get(callId)?.subagent) return;

    if (message.subtype === "task_started") {
      const description = boundedString(message.description, SUBAGENT_DESCRIPTION_LIMIT);
      const role = boundedString(message.subagent_type, SUBAGENT_DESCRIPTION_LIMIT);
      const agentId = boundedString(message.task_id, SUBAGENT_DESCRIPTION_LIMIT);
      events.push({
        type: "subagent.updated",
        callId,
        status: "running",
        ...(description ? { description } : {}),
        ...(role ? { role } : {}),
        ...(agentId ? { nativeSubagentId: agentId } : {}),
      });
      return;
    }
    if (message.subtype === "task_progress") {
      const description = boundedString(message.description, SUBAGENT_DESCRIPTION_LIMIT);
      const role = boundedString(message.subagent_type, SUBAGENT_DESCRIPTION_LIMIT);
      const resultSummary = boundedString(message.summary, SUBAGENT_SUMMARY_LIMIT);
      const agentId = boundedString(message.task_id, SUBAGENT_DESCRIPTION_LIMIT);
      events.push({
        type: "subagent.updated",
        callId,
        status: "running",
        ...(description ? { description } : {}),
        ...(role ? { role } : {}),
        ...(agentId ? { nativeSubagentId: agentId } : {}),
        ...(resultSummary ? { resultSummary } : {}),
      });
      return;
    }
    if (message.subtype === "task_updated" && isRecord(message.patch)) {
      const status = taskStatus(message.patch.status);
      if (!status) return;
      const description = boundedString(message.patch.description, SUBAGENT_DESCRIPTION_LIMIT);
      const resultSummary = boundedString(message.patch.error, SUBAGENT_SUMMARY_LIMIT);
      const agentId = boundedString(message.task_id, SUBAGENT_DESCRIPTION_LIMIT);
      events.push({
        type: "subagent.updated",
        callId,
        status,
        ...(description ? { description } : {}),
        ...(agentId ? { nativeSubagentId: agentId } : {}),
        ...(resultSummary ? { resultSummary } : {}),
      });
      return;
    }
    if (message.subtype === "task_notification") {
      const status = taskStatus(message.status);
      if (!status) return;
      const resultSummary = boundedString(message.summary, SUBAGENT_SUMMARY_LIMIT);
      const agentId = boundedString(message.task_id, SUBAGENT_DESCRIPTION_LIMIT);
      events.push({
        type: "subagent.updated",
        callId,
        status,
        ...(agentId ? { nativeSubagentId: agentId } : {}),
        ...(resultSummary ? { resultSummary } : {}),
      });
    }
  }

  #consumeStreamEvent(message: Record<string, unknown>, events: ClaudeNativeEvent[]): void {
    const event = message.event;
    if (!isRecord(event)) return;
    if (
      event.type === "message_start" &&
      isRecord(event.message) &&
      typeof event.message.id === "string" &&
      event.message.id.length > 0
    ) {
      this.#activeRootStreamMessageId = event.message.id;
      this.#messageState(event.message.id);
      return;
    }
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) return;
    const messageId =
      this.#activeRootStreamMessageId ?? nativeUuid(message) ?? this.#nextMessageId();
    if (!this.#activeRootStreamMessageId) this.#activeRootStreamMessageId = messageId;
    const state = this.#messageState(messageId);
    if (state.completed) {
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
    const checkpointId = nativeUuid(message);
    const nativeMessageId = assistantNativeMessageId(message);
    const messageId =
      this.#activeRootStreamMessageId ?? nativeMessageId ?? checkpointId ?? this.#nextMessageId();
    const state = this.#messageState(messageId);
    if (state.completed) return;

    if (state.reasoning.length > 0) {
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
      const subagent = SUBAGENT_TOOLS.has(block.name);
      this.#tools.set(block.id, { name: block.name, subagent });
      if (subagent) {
        const prompt = subagentPrompt(argumentsResult.data);
        const role = subagentRole(argumentsResult.data);
        const agentId = targetedSubagentId(argumentsResult.data);
        events.push({
          type: "subagent.started",
          callId: block.id,
          operation: block.name === "SendMessage" ? "send" : "spawn",
          description: subagentDescription(argumentsResult.data, block.name),
          ...(prompt ? { prompt } : {}),
          ...(role ? { role } : {}),
          background: block.name === "SendMessage" || subagentBackground(argumentsResult.data),
          ...(agentId ? { nativeSubagentId: agentId } : {}),
        });
      } else {
        events.push({
          type: "tool.started",
          callId: block.id,
          toolName: block.name,
          arguments: argumentsResult.data,
        });
      }
    }

    if (!this.#protocolConflict && !this.#textConflict) {
      events.push({
        type: "message.completed",
        messageId,
        ...(checkpointId ? { checkpointId } : {}),
      });
    }
    state.completed = true;
    if (this.#activeRootStreamMessageId === messageId) this.#activeRootStreamMessageId = null;
  }

  #consumeToolProgress(message: Record<string, unknown>, events: ClaudeNativeEvent[]): void {
    const callId = message.tool_use_id;
    const elapsedSeconds = message.elapsed_time_seconds;
    if (
      typeof callId !== "string" ||
      this.#tools.get(callId)?.subagent !== false ||
      typeof elapsedSeconds !== "number" ||
      !Number.isFinite(elapsedSeconds) ||
      elapsedSeconds < 0
    ) {
      return;
    }
    events.push({ type: "tool.progress", callId, elapsedMs: Math.round(elapsedSeconds * 1_000) });
  }

  #consumeToolResults(
    message: Record<string, unknown>,
    events: ClaudeNativeEvent[],
    ignoreUnknown: boolean,
  ): void {
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
      const tool = this.#tools.get(callId);
      if (!tool || this.#completedToolIds.has(callId)) {
        if (!ignoreUnknown) this.#protocolConflict = true;
        continue;
      }
      if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
        this.#protocolConflict = true;
        continue;
      }
      this.#tools.delete(callId);
      this.#completedToolIds.add(callId);
      const isError = block.is_error === true;
      const nativeResult =
        resultBlocks.length === 1 ? (message.tool_use_result ?? message.toolUseResult) : undefined;
      const outputText = resultText(block.content, nativeResult);
      if (tool.subagent) {
        const resultSummary = boundedString(outputText, SUBAGENT_SUMMARY_LIMIT);
        const agentId = nativeSubagentId(nativeResult, outputText);
        events.push({
          type: "subagent.completed",
          callId,
          isError,
          ...(subagentContinuesInBackground(nativeResult, outputText)
            ? { continuesInBackground: true }
            : {}),
          ...(agentId ? { nativeSubagentId: agentId } : {}),
          ...(resultSummary ? { resultSummary } : {}),
        });
        continue;
      }
      const fileChange = isError ? null : parseClaudeNativeFileChange(tool.name, nativeResult);
      events.push({
        type: "tool.completed",
        callId,
        toolName: tool.name,
        ...(outputText ? { outputText } : {}),
        isError,
        ...(fileChange ? { fileChange } : {}),
      });
    }
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
