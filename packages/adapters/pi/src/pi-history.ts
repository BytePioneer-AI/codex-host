import type {
  HostAgentMessageItem,
  HostContextCompactionItem,
  HostFileChangeItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostReasoningItem,
  HostThreadSnapshot,
  HostToolExecutionItem,
  HostToolOutput,
  HistoricalTurnOutcome,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type JsonObject,
  type JsonValue,
  type NativeCheckpointRef,
} from "@codexhost/shared-contracts";

import { piNestedCallFileChanges, piToolFileChanges } from "./pi-file-change.js";
import { PiSubagents } from "./pi-subagents.js";
import { encodePiModelRef, type PiNativeModelRef } from "./pi-model-catalog.js";

export interface PiSessionHistory {
  entries: JsonObject[];
  leafId: string | null;
}

export interface PiHistoryState {
  sessionId: string;
  model: PiNativeModelRef | null;
  /** Session cwd for file change paths; snapshots used only for Turn identity omit it. */
  cwd?: string;
}

interface PiEntry extends JsonObject {
  id: string;
  parentId: string | null;
  type: string;
}

const piHarnessId: HarnessId = harnessIdSchema.parse("pi");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

function thinkingContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "thinking" && typeof part.thinking === "string",
    )
    .map((part) => part.thinking as string)
    .join("");
}

function validatedEntry(value: JsonObject): PiEntry {
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    typeof value.type !== "string"
  ) {
    throw new Error("Pi history contains an invalid Entry identity");
  }
  return value as PiEntry;
}

export function activePiEntries(history: PiSessionHistory): PiEntry[] {
  if (history.leafId === null) return [];
  const byId = new Map(
    history.entries.map((value) => {
      const entry = validatedEntry(value);
      return [entry.id, entry] as const;
    }),
  );
  const reversed: PiEntry[] = [];
  const visited = new Set<string>();
  let current: string | null = history.leafId;
  while (current !== null) {
    if (visited.has(current)) throw new Error("Pi history active branch contains a cycle");
    visited.add(current);
    const entry = byId.get(current);
    if (!entry) throw new Error("Pi history active branch references a missing Entry");
    reversed.push(entry);
    current = entry.parentId;
  }
  return reversed.reverse();
}

function message(entry: PiEntry): Record<string, unknown> | null {
  return entry.type === "message" && isRecord(entry.message) ? entry.message : null;
}

function messageRole(entry: PiEntry): string | null {
  const value = message(entry)?.role;
  return typeof value === "string" ? value : null;
}

function itemId(entryId: string, kind: string, ordinal: number) {
  return hostItemIdSchema.parse(`pi-item-v1-${entryId}-${kind}-${ordinal}`);
}

function assistantOutcome(entries: PiEntry[]): HistoricalTurnOutcome {
  const assistants = entries
    .map((entry) => message(entry))
    .filter((value): value is Record<string, unknown> => value?.role === "assistant");
  const final = assistants.at(-1);
  if (!final) return { status: "unknown", reason: "Pi history has no Assistant terminal" };
  const stopReason = final.stopReason;
  if (stopReason === "aborted") {
    return { status: "cancelled", reason: "Pi Assistant was aborted" };
  }
  if (stopReason === "error") {
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message:
          typeof final.errorMessage === "string" && final.errorMessage.length > 0
            ? final.errorMessage
            : "Pi Assistant failed",
        retryable: false,
      },
    };
  }
  if (typeof stopReason === "string" || textContent(final.content).length > 0) {
    return { status: "succeeded" };
  }
  return { status: "unknown", reason: "Pi Assistant terminal is not classifiable" };
}

function itemOutcome(outcome: HistoricalTurnOutcome): HostItemOutcome {
  if (outcome.status === "failed") return { status: "failed", error: outcome.error };
  if (outcome.status === "cancelled") {
    return {
      status: "cancelled",
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }
  return { status: "succeeded" };
}

function toolOutput(value: unknown): HostToolOutput | undefined {
  const text = textContent(value);
  return text.length > 0 ? { content: [{ type: "text", text }] } : undefined;
}

/** The file changes the live Turn showed for this tool call; history has no fileChange Items. */
function historicalFileChanges(
  call: { entryId: string; ordinal: number; name: string; arguments: JsonValue },
  nativeMessage: Record<string, unknown>,
  toolItemId: HostToolExecutionItem["itemId"],
  cwd: string,
): HostFileChangeItem[] {
  const items: HostFileChangeItem[] = [];
  const changes =
    nativeMessage.isError === false
      ? piToolFileChanges(call.name, call.arguments, nativeMessage, cwd)
      : null;
  if (changes) {
    items.push({
      type: "fileChange",
      itemId: itemId(call.entryId, "file", call.ordinal),
      sourceItemIds: [toolItemId],
      changes,
    });
  }
  for (const nested of piNestedCallFileChanges(nativeMessage.nestedCalls, cwd)) {
    items.push({
      type: "fileChange",
      itemId: itemId(call.entryId, `nested-${nested.index}-file`, call.ordinal),
      sourceItemIds: [toolItemId],
      changes: nested.changes,
    });
  }
  return items;
}

function snapshotItems(
  entries: PiEntry[],
  outcome: HistoricalTurnOutcome,
  subagents?: PiSubagents,
  cwd?: string,
): HostItemSnapshot[] {
  const snapshots: HostItemSnapshot[] = [];
  const toolCalls = new Map<
    string,
    { entryId: string; ordinal: number; name: string; arguments: JsonValue }
  >();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      const item: HostContextCompactionItem = {
        type: "contextCompaction",
        itemId: itemId(entry.id, "compaction", 0),
      };
      // Pi writes this Entry only after the native summary has landed. Both
      // manual and automatic compaction use the same durable Entry shape, so
      // history recovery preserves the confirmed event without guessing its source.
      snapshots.push({ item, outcome: { status: "succeeded" } });
      continue;
    }
    const nativeMessage = message(entry);
    if (!nativeMessage) continue;
    const content = Array.isArray(nativeMessage.content) ? nativeMessage.content : [];
    if (nativeMessage.role === "assistant") {
      const text = textContent(content);
      const reasoning = thinkingContent(content);
      let projectedText = false;
      let projectedReasoning = false;
      for (const [ordinal, part] of content.entries()) {
        if (!isRecord(part)) continue;
        if (part.type === "thinking" && !projectedReasoning && reasoning.length > 0) {
          const item: HostReasoningItem = {
            type: "reasoning",
            itemId: itemId(entry.id, "reasoning", 0),
            text: reasoning,
          };
          snapshots.push({ item, outcome: itemOutcome(outcome) });
          projectedReasoning = true;
          continue;
        }
        if (part.type === "text" && !projectedText && text.length > 0) {
          const item: HostAgentMessageItem = {
            type: "agentMessage",
            itemId: itemId(entry.id, "assistant", 0),
            text,
          };
          snapshots.push({ item, outcome: itemOutcome(outcome) });
          projectedText = true;
          continue;
        }
        if (
          part.type !== "toolCall" ||
          typeof part.id !== "string" ||
          typeof part.name !== "string"
        ) {
          continue;
        }
        const parsedArguments = jsonValueSchema.safeParse(part.arguments);
        if (!parsedArguments.success) continue;
        toolCalls.set(part.id, {
          entryId: entry.id,
          ordinal,
          name: part.name,
          arguments: parsedArguments.data,
        });
      }
      continue;
    }
    if (
      nativeMessage.role !== "toolResult" ||
      typeof nativeMessage.toolCallId !== "string" ||
      typeof nativeMessage.toolName !== "string"
    ) {
      continue;
    }
    const call = toolCalls.get(nativeMessage.toolCallId);
    if (!call || call.name !== nativeMessage.toolName) continue;
    const output = toolOutput(nativeMessage.content);
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: itemId(call.entryId, "tool", call.ordinal),
      toolName: call.name,
      arguments: call.arguments,
      ...(output ? { output } : {}),
    };
    const toolSucceeded = nativeMessage.isError === false;
    const delegation = subagents?.project(
      call.name,
      nativeMessage,
      itemId(call.entryId, "subagent", call.ordinal),
      nativeMessage.toolCallId,
    );
    snapshots.push({
      item,
      outcome: toolSucceeded
        ? { status: "succeeded" }
        : {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: `Pi Tool '${call.name}' failed`,
              retryable: false,
            },
          },
    });
    if (cwd) {
      for (const fileItem of historicalFileChanges(call, nativeMessage, item.itemId, cwd)) {
        snapshots.push({ item: fileItem, outcome: { status: "succeeded" } });
      }
    }
    if (delegation) snapshots.push({ item: delegation, outcome: { status: "succeeded" } });
  }
  return snapshots;
}

function modelChange(entry: PiEntry): PiNativeModelRef | null {
  return entry.type === "model_change" &&
    typeof entry.provider === "string" &&
    typeof entry.modelId === "string"
    ? { provider: entry.provider, id: entry.modelId }
    : null;
}

function turnStarts(active: PiEntry[]): { entry: PiEntry; index: number }[] {
  const starts: { entry: PiEntry; index: number }[] = [];
  let terminal = true;
  let pending: { entry: PiEntry; index: number } | null = null;
  for (const [index, entry] of active.entries()) {
    const role = messageRole(entry);
    if (role === "user") {
      starts.push({ entry, index });
      pending = null;
      terminal = false;
    } else if ((entry.type === "custom_message" || role === "custom") && terminal) {
      pending ??= { entry, index };
    } else if (role === "assistant") {
      // Custom messages can also be injected during a run, or appended without
      // triggering one. Only a subsequent Assistant after a terminal starts a run.
      if (pending) starts.push(pending);
      pending = null;
      terminal = ["stop", "aborted", "error"].includes(String(message(entry)?.stopReason));
    }
  }
  return starts;
}

export function mapPiSnapshot(
  history: PiSessionHistory,
  state: PiHistoryState,
  subagents: PiSubagents = new PiSubagents(() => undefined),
): HostThreadSnapshot {
  const active = activePiEntries(history);
  const turns: HostThreadSnapshot["turns"] = [];
  const starts = turnStarts(active);
  const byIndex = new Map(starts.map((start, ordinal) => [start.index, ordinal]));
  let effectiveModel = state.model;
  for (let index = 0; index < active.length;) {
    const model = modelChange(active[index] as PiEntry);
    if (model) {
      effectiveModel = model;
      index += 1;
      continue;
    }
    const user = active[index] as PiEntry;
    const ordinal = byIndex.get(index);
    if (ordinal === undefined) {
      index += 1;
      continue;
    }
    const next = starts[ordinal + 1];
    const end = next?.index ?? active.length;
    const entries = active.slice(index, end);
    const outcome = assistantOutcome(entries);
    const userText = textContent(message(user)?.content);
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: piHarnessId,
      nativeSessionId: state.sessionId,
      nativeTurnKey: user.id,
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: piHarnessId,
      nativeSessionId: state.sessionId,
      checkpointId: user.id,
      formatVersion: 1,
    }) as NativeCheckpointRef;
    turns.push({
      nativeTurnRef,
      ...(!next || messageRole(next.entry) === "user" ? { checkpoint } : {}),
      input: messageRole(user) === "user" ? [{ type: "text", text: userText }] : [],
      items: snapshotItems(entries, outcome, subagents, state.cwd),
      outcome,
      ...(effectiveModel ? { model: encodePiModelRef(effectiveModel) } : {}),
    });
    for (const entry of entries) {
      const changed = modelChange(entry);
      if (changed) effectiveModel = changed;
    }
    index = end;
  }
  return { turns };
}

export function resolvePiLastTurnBoundary(
  history: PiSessionHistory,
): { lastUserEntryId: string | null; sourceTurnCount: number } | null {
  const starts = turnStarts(activePiEntries(history));
  const last = starts.at(-1)?.entry;
  return last
    ? {
        lastUserEntryId: messageRole(last) === "user" ? last.id : null,
        sourceTurnCount: starts.length,
      }
    : null;
}

export function resolvePiForkBoundary(
  history: PiSessionHistory,
  checkpointId: string,
): { targetTurnIndex: number; nextUserEntryId: string | null } {
  const active = activePiEntries(history);
  const starts = turnStarts(active);
  const targetTurnIndex = starts.findIndex(({ entry }) => entry.id === checkpointId);
  if (targetTurnIndex < 0) throw new Error("Pi Checkpoint is not on the active branch");
  const next = starts[targetTurnIndex + 1]?.entry;
  if (next && messageRole(next) !== "user") {
    throw new Error("Pi cannot Fork immediately before a custom-triggered Turn");
  }
  return { targetTurnIndex, nextUserEntryId: next?.id ?? null };
}
