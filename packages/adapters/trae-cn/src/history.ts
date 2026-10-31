import type {
  HistoricalTurnOutcome,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostThreadSnapshot,
  HostTextInput,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeTurnRefSchema,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";
import { confirmedModel } from "./models.js";
import { record, TraeError } from "./errors.js";

export const TRAE_CN_ID = harnessIdSchema.parse("trae-cn");

export function nativeTurnRef(sessionId: string, userMessageId: string) {
  // The native user message ID is acknowledged and durably stored, and assistant
  // replies point to it. It survives process restarts independently of Host IDs.
  return nativeTurnRefSchema.parse({
    harnessId: TRAE_CN_ID,
    nativeSessionId: sessionId,
    nativeTurnKey: userMessageId,
    formatVersion: 1,
  });
}

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TraeError("protocolError", "Invalid TRAE CN history content JSON");
  }
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TraeError("protocolError", `Missing native ${name}`);
  return value;
}

function nativeFailure(value: unknown) {
  return {
    code: "nativeFailure" as const,
    message:
      record(value) && typeof value.message === "string"
        ? value.message
        : "TRAE CN native task failed",
    retryable: false,
  };
}

export function turnOutcome(value: unknown, error?: unknown): HistoricalTurnOutcome {
  if (value === "completed") return { status: "succeeded" };
  if (value === "canceled" || value === "cancelled") return { status: "cancelled" };
  if (value === "failed") return { status: "failed", error: nativeFailure(error) };
  return { status: "unknown", reason: "TRAE CN has not confirmed a terminal task status" };
}

export interface ProjectedPlanItem {
  item: HostItem;
  /** Absent while the native Item is still running. */
  outcome?: HostItemOutcome;
}

/** One native plan_item can contain separate reasoning, commentary and tool/answer Items. */
export function projectPlanItem(value: unknown, terminal?: HostItemOutcome): ProjectedPlanItem[] {
  if (!record(value)) throw new TraeError("protocolError", "Invalid TRAE CN plan item");
  const id = nonempty(value.id, "plan item ID");
  const result: ProjectedPlanItem[] = [];
  const call = record(value.tool_call_info) ? value.tool_call_info : undefined;
  const name = typeof call?.name === "string" ? call.name : "";
  const toolResult = record(call?.result) ? call.result : undefined;
  const timing = record(value.timing) ? value.timing : undefined;
  const toolFinished = typeof timing?.tool_call_finished_at_ms === "number";
  const completed =
    toolFinished || (record(value.agent_status) && value.agent_status.status === "completed");
  const textOutcome = completed ? { status: "succeeded" as const } : terminal;
  for (const [key, type] of [
    ["reasoning_content", "reasoning"],
    ["thought", "agentMessage"],
  ] as const) {
    // Builder streams final answer text through thought before its finish call
    // is complete, then clears thought in durable history. Wait for the native
    // call kind before publishing commentary; finish.summary owns final text.
    if (key === "thought" && (!name || name === "finish" || name === "ReplyUser")) continue;
    if (typeof value[key] === "string" && value[key]) {
      const itemId = hostItemIdSchema.parse(`${id}.${key}`);
      result.push({
        item:
          type === "reasoning"
            ? { type, itemId, text: value[key] }
            : { type, itemId, text: value[key], phase: "commentary" },
        ...(textOutcome ? { outcome: textOutcome } : {}),
      });
    }
  }
  if (!name) return result;
  const params = decoded(call?.params);
  let outcome: HostItemOutcome | undefined;
  if (toolResult?.status === "success") outcome = { status: "succeeded" };
  else if (toolResult?.status === "failed" || toolResult?.status === "error")
    outcome = { status: "failed", error: nativeFailure({ message: toolResult.error_message }) };
  else if (toolResult?.status === "canceled" || toolResult?.status === "cancelled")
    outcome = { status: "cancelled" };
  else outcome = terminal;
  if (name === "finish" || name === "ReplyUser") {
    if (record(params) && typeof params.summary === "string")
      result.push({
        item: {
          type: "agentMessage",
          itemId: hostItemIdSchema.parse(`${id}.answer`),
          text: params.summary,
          phase: "final_answer",
        },
        ...(outcome ? { outcome } : {}),
      });
    else if (completed) throw new TraeError("protocolError", "Native final answer has no summary");
  } else if (typeof timing?.tool_call_started_at_ms === "number" || toolFinished || terminal) {
    const item: HostItem = {
      type: "toolExecution",
      itemId: hostItemIdSchema.parse(`${id}.tool`),
      toolName: name,
      arguments: jsonValueSchema.parse(params ?? {}),
    };
    // Some native tools omit durable output entirely. Preserve that absence; do
    // not fabricate file contents or substitute call arguments as tool output.
    if (toolResult?.data !== undefined)
      item.output = {
        content: [
          {
            type: "text",
            text:
              typeof toolResult.data === "string"
                ? toolResult.data
                : JSON.stringify(toolResult.data),
          },
        ],
        ...(toolResult.is_truncated === true ? { truncated: true } : {}),
      };
    if (
      typeof timing?.tool_call_started_at_ms === "number" &&
      typeof timing.tool_call_finished_at_ms === "number"
    )
      item.durationMs = Math.max(
        0,
        timing.tool_call_finished_at_ms - timing.tool_call_started_at_ms,
      );
    result.push({ item, ...(outcome ? { outcome } : {}) });
  }
  return result;
}

interface NativeMessage {
  id: string;
  role: "user" | "assistant";
  index: number;
  value: Record<string, unknown>;
}

function inputContent(value: unknown): HostTextInput[] {
  const content = decoded(value);
  if (!Array.isArray(content) || !content.length)
    throw new TraeError("protocolError", "Missing native user input");
  return content.map((part): HostTextInput => {
    if (!record(part) || part.type !== "text" || typeof part.text_content !== "string")
      throw new TraeError("unsupported", "This TRAE CN history contains non-text input");
    return { type: "text", text: part.text_content };
  });
}

/** Read-only history projection; active and missing terminal records remain unknown. */
export function projectHistory(
  value: unknown,
  sessionId: string,
  agentType: string,
): HostThreadSnapshot {
  if (!record(value) || value.sessionId !== sessionId || !Array.isArray(value.items))
    throw new TraeError("protocolError", "Invalid TRAE CN history snapshot");
  const ids = new Set<string>();
  const messages = value.items
    .map((entry): NativeMessage => {
      if (
        !record(entry) ||
        entry.chat_session_id !== sessionId ||
        !Number.isSafeInteger(entry.message_index) ||
        (entry.role !== "user" && entry.role !== "assistant")
      )
        throw new TraeError("protocolError", "Invalid native history message");
      const id = nonempty(entry.message_id, "message ID");
      if (ids.has(id)) throw new TraeError("protocolError", "Duplicate native history message ID");
      ids.add(id);
      return { id, index: entry.message_index as number, role: entry.role, value: entry };
    })
    .sort((left, right) => left.index - right.index);
  const users = messages.filter((message) => message.role === "user");
  const userIds = new Set(users.map((message) => message.id));
  for (const message of messages)
    if (
      message.role === "assistant" &&
      !userIds.has(nonempty(message.value.reply_to_message_id, "reply identity"))
    )
      throw new TraeError(
        "protocolError",
        "Native assistant reply has no corresponding user message",
      );
  const turns = users.map((user) => {
    const replies = messages.filter(
      (message) => message.role === "assistant" && message.value.reply_to_message_id === user.id,
    );
    if (replies.length > 1)
      throw new TraeError(
        "unsupported",
        "Multiple native tasks for one user message require autonomous Turn projection",
      );
    const reply = replies[0]?.value;
    const outcome = turnOutcome(reply?.status, reply?.error);
    const terminal: HostItemOutcome | undefined =
      outcome.status === "unknown" ? undefined : outcome;
    const items: HostItemSnapshot[] = [];
    if (reply) {
      const content = decoded(reply.content);
      if (!record(content) || !Array.isArray(content.messages))
        throw new TraeError("unsupported", "Unsupported native assistant history format");
      const itemIds = new Set<string>();
      for (const message of content.messages) {
        if (!record(message) || message.type !== "plan_item")
          throw new TraeError("unsupported", "Unsupported native task history Item");
        for (const projected of projectPlanItem(message.plan_item, terminal)) {
          if (itemIds.has(projected.item.itemId))
            throw new TraeError("protocolError", "Duplicate native plan item identity");
          itemIds.add(projected.item.itemId);
          if (projected.outcome) items.push({ item: projected.item, outcome: projected.outcome });
        }
      }
    }
    const model: HarnessModelRef | undefined = confirmedModel(
      reply?.model ?? user.value.model,
      agentType,
    );
    return {
      nativeTurnRef: nativeTurnRef(sessionId, user.id),
      input: inputContent(user.value.content),
      items,
      outcome,
      ...(model ? { model } : {}),
      ...(typeof reply?.chat_start_time === "number" ? { startedAtMs: reply.chat_start_time } : {}),
      ...(typeof reply?.chat_end_time === "number" ? { completedAtMs: reply.chat_end_time } : {}),
    };
  });
  return { turns };
}
