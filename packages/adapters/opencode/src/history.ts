import { z } from "zod";

import type {
  AssistantMessage,
  Message,
  Part,
  Session,
  SnapshotFileDiff,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2";

import type {
  HarnessExecutionPolicy,
  HistoricalTurnOutcome,
  HostAgentMessageItem,
  HostContextCompactionItem,
  HostFileChange,
  HostFileChangeItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostReasoningItem,
  HostThreadSnapshot,
  HostToolExecutionItem,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HostItemId,
  type JsonValue,
  type NativeCheckpointRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { encodeOpenCodeModelRef } from "./model-catalog.js";

export interface OpenCodeMessageWithParts {
  info: Message;
  parts: Part[];
}

export interface OpenCodeHistoryInput {
  session: Session;
  messages: readonly OpenCodeMessageWithParts[];
  diffsByUserMessageId?: ReadonlyMap<string, readonly SnapshotFileDiff[]>;
  toolOutputLimit: number;
}

const openCodeHarnessId: HarnessId = harnessIdSchema.parse("opencode");

export const openCodeExecutionPolicySchema = z.enum(["default", "unattended-full-access"]);
export type OpenCodeExecutionPolicy = HarnessExecutionPolicy;

const openCodeSessionLocatorSchema = z.strictObject({
  directory: z.string().min(1),
  executionPolicy: openCodeExecutionPolicySchema.optional(),
});

export function parseOpenCodeSessionRef(ref: unknown): {
  ref: NativeSessionRef;
  directory?: string;
  executionPolicy: OpenCodeExecutionPolicy;
} {
  const parsed = nativeSessionRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new Error(`Invalid OpenCode Native Session Ref: ${parsed.error.message}`);
  }
  if (parsed.data.harnessId !== openCodeHarnessId) {
    throw new Error("Invalid OpenCode Native Session Ref harnessId");
  }
  const locator = parsed.data.locator;
  if (locator === undefined) {
    return { ref: parsed.data, executionPolicy: "default" };
  }
  const locatorResult = openCodeSessionLocatorSchema.safeParse(locator);
  if (!locatorResult.success) {
    throw new Error(`Invalid OpenCode Native Session locator: ${locatorResult.error.message}`);
  }
  return {
    ref: parsed.data,
    directory: locatorResult.data.directory,
    executionPolicy: locatorResult.data.executionPolicy ?? "default",
  };
}

function itemId(nativeId: string): HostItemId {
  return hostItemIdSchema.parse(nativeId);
}

export function openCodeNativeSessionRef(
  session: Session,
  executionPolicy: OpenCodeExecutionPolicy = "default",
): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    harnessId: openCodeHarnessId,
    nativeSessionId: session.id,
    locator: { directory: session.directory, executionPolicy },
    formatVersion: 1,
  });
}

function activeMessages(
  session: Session,
  messages: readonly OpenCodeMessageWithParts[],
): OpenCodeMessageWithParts[] {
  if (!session.revert) return [...messages];
  const boundary = messages.findIndex(({ info }) => info.id === session.revert?.messageID);
  if (boundary < 0) {
    throw new Error("OpenCode Session revert boundary is absent from its transcript");
  }
  return messages.slice(0, boundary + (session.revert.partID ? 1 : 0));
}

function messageErrorText(message: AssistantMessage): string {
  const data = message.error?.data;
  return data && "message" in data && typeof data.message === "string"
    ? data.message
    : "OpenCode Assistant failed";
}

function assistantOutcome(message: AssistantMessage | undefined): HistoricalTurnOutcome {
  if (!message) {
    return { status: "unknown", reason: "OpenCode history has no Assistant terminal" };
  }
  if (message.error?.name === "MessageAbortedError") {
    return { status: "cancelled", reason: messageErrorText(message) };
  }
  if (message.error) {
    return {
      status: "failed",
      error: {
        code:
          message.error.name === "ProviderAuthError" ? "authenticationRequired" : "nativeFailure",
        message: messageErrorText(message),
        retryable:
          message.error.name === "ProviderAuthError" ||
          (message.error.name === "APIError" && message.error.data.isRetryable),
      },
    };
  }
  if (message.time.completed !== undefined || message.finish) return { status: "succeeded" };
  return { status: "unknown", reason: "OpenCode Assistant message is not terminal" };
}

function completedItemOutcome(outcome: HistoricalTurnOutcome): HostItemOutcome {
  if (outcome.status === "failed") return { status: "failed", error: outcome.error };
  if (outcome.status === "cancelled") {
    return { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  return { status: "succeeded" };
}

function boundedToolOutput(text: string, limit: number): HostToolOutput | undefined {
  if (!text) return undefined;
  const truncated = text.length > limit;
  return {
    content: [{ type: "text", text: truncated ? text.slice(0, limit) : text }],
    ...(truncated ? { truncated: true } : {}),
  };
}

function reliableToolArguments(part: ToolPart): JsonValue | null {
  const parsed = jsonValueSchema.safeParse(part.state.input);
  return parsed.success ? parsed.data : null;
}

function toolSnapshot(part: ToolPart, limit: number): HostItemSnapshot | null {
  const arguments_ = reliableToolArguments(part);
  if (arguments_ === null) return null;
  if (part.state.status !== "completed" && part.state.status !== "error") return null;
  const output =
    part.state.status === "completed" ? boundedToolOutput(part.state.output, limit) : undefined;
  const item: HostToolExecutionItem = {
    type: "toolExecution",
    itemId: itemId(part.id),
    toolName: part.tool,
    arguments: arguments_,
    ...(part.state.status === "completed"
      ? {
          ...(output ? { output } : {}),
          durationMs: Math.max(0, part.state.time.end - part.state.time.start),
        }
      : { durationMs: Math.max(0, part.state.time.end - part.state.time.start) }),
  };
  return {
    item,
    outcome:
      part.state.status === "completed"
        ? { status: "succeeded" }
        : {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: part.state.error || `OpenCode Tool '${part.tool}' failed`,
              retryable: false,
            },
          },
  };
}

function assistantItems(
  entry: OpenCodeMessageWithParts,
  outcome: HistoricalTurnOutcome,
  toolOutputLimit: number,
): HostItemSnapshot[] {
  if (entry.info.role !== "assistant") return [];
  const items: HostItemSnapshot[] = [];
  for (const part of entry.parts) {
    if (part.type === "text" && !part.ignored && part.text) {
      const item: HostAgentMessageItem = {
        type: "agentMessage",
        itemId: itemId(part.id),
        text: part.text,
      };
      items.push({ item, outcome: completedItemOutcome(outcome) });
      continue;
    }
    if (part.type === "reasoning" && part.text) {
      const item: HostReasoningItem = {
        type: "reasoning",
        itemId: itemId(part.id),
        text: part.text,
      };
      items.push({ item, outcome: completedItemOutcome(outcome) });
      continue;
    }
    if (part.type === "tool") {
      const snapshot = toolSnapshot(part, toolOutputLimit);
      if (snapshot) items.push(snapshot);
      continue;
    }
    if (part.type === "compaction") {
      const item: HostContextCompactionItem = {
        type: "contextCompaction",
        itemId: itemId(part.id),
      };
      items.push({ item, outcome: { status: "succeeded" } });
    }
  }
  return items;
}

export function reliableOpenCodeFileChanges(diffs: readonly SnapshotFileDiff[]): HostFileChange[] {
  return diffs.flatMap((diff) => {
    if (!diff.file || !diff.patch || !diff.status) return [];
    const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "delete" : "update";
    return [{ path: diff.file, kind, unifiedDiff: diff.patch } satisfies HostFileChange];
  });
}

function userText(entry: OpenCodeMessageWithParts): string {
  return entry.parts
    .filter(
      (part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.ignored,
    )
    .map(({ text }) => text)
    .join("");
}

export function projectOpenCodeHistory(input: OpenCodeHistoryInput): HostThreadSnapshot {
  const messages = activeMessages(input.session, input.messages);
  const turns: HostThreadSnapshot["turns"] = [];
  for (let index = 0; index < messages.length;) {
    const userEntry = messages[index] as OpenCodeMessageWithParts;
    if (userEntry.info.role !== "user") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < messages.length && messages[end]?.info.role !== "user") end += 1;
    const turnEntries = messages.slice(index, end);
    const assistants = turnEntries.filter(
      (entry): entry is OpenCodeMessageWithParts & { info: AssistantMessage } =>
        entry.info.role === "assistant",
    );
    const terminal = assistants.at(-1)?.info;
    const outcome = assistantOutcome(terminal);
    const items = assistants.flatMap((entry) =>
      assistantItems(entry, assistantOutcome(entry.info), input.toolOutputLimit),
    );
    const changes = reliableOpenCodeFileChanges(
      input.diffsByUserMessageId?.get(userEntry.info.id) ?? [],
    );
    if (changes.length > 0) {
      const item: HostFileChangeItem = {
        type: "fileChange",
        itemId: itemId(`opencode-diff:${userEntry.info.id}`),
        changes,
      };
      items.push({ item, outcome: { status: "succeeded" } });
    }
    const checkpoint = terminal
      ? (nativeCheckpointRefSchema.parse({
          harnessId: openCodeHarnessId,
          nativeSessionId: input.session.id,
          checkpointId: terminal.id,
          formatVersion: 1,
        }) as NativeCheckpointRef)
      : undefined;
    const user = userEntry.info as UserMessage;
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: openCodeHarnessId,
        nativeSessionId: input.session.id,
        nativeTurnKey: user.id,
        formatVersion: 1,
      }),
      ...(checkpoint ? { checkpoint } : {}),
      input: [{ type: "text", text: userText(userEntry) }],
      items,
      outcome,
      model: encodeOpenCodeModelRef(user.model),
    });
    index = end;
  }
  return { turns };
}

export function openCodeAssistantMessages(
  session: Session,
  messages: readonly OpenCodeMessageWithParts[],
): AssistantMessage[] {
  return activeMessages(session, messages)
    .map(({ info }) => info)
    .filter((info): info is AssistantMessage => info.role === "assistant");
}

export function resolveOpenCodeForkBoundary(
  session: Session,
  messages: readonly OpenCodeMessageWithParts[],
  checkpoint: NativeCheckpointRef,
): { messageID?: string; sourceTurnCount: number } | null {
  if (checkpoint.harnessId !== openCodeHarnessId || checkpoint.nativeSessionId !== session.id) {
    return null;
  }
  const active = activeMessages(session, messages);
  const checkpointIndex = active.findIndex(({ info }) => info.id === checkpoint.checkpointId);
  if (checkpointIndex < 0 || active[checkpointIndex]?.info.role !== "assistant") return null;
  const targetUserCount = active
    .slice(0, checkpointIndex + 1)
    .filter(({ info }) => info.role === "user").length;
  const nextMessage = active[checkpointIndex + 1]?.info.id;
  return {
    ...(nextMessage ? { messageID: nextMessage } : {}),
    sourceTurnCount: targetUserCount,
  };
}

export function resolveOpenCodeLastTurnBoundary(
  session: Session,
  messages: readonly OpenCodeMessageWithParts[],
): { lastUserMessageID: string; sourceTurnCount: number } | null {
  const users = activeMessages(session, messages).filter(
    (entry): entry is OpenCodeMessageWithParts & { info: UserMessage } =>
      entry.info.role === "user",
  );
  const last = users.at(-1);
  return last ? { lastUserMessageID: last.info.id, sourceTurnCount: users.length } : null;
}
