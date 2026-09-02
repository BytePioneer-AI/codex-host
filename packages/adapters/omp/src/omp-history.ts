import type {
  HostAgentMessageItem,
  HostCommandExecutionItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostReasoningItem,
  HostSubagentDelegationItem,
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

import { encodeOmpModelRef, type OmpNativeModelRef } from "./omp-model-catalog.js";
import {
  isOmpProcessId,
  isOmpProcessTool,
  ompNativeSubagentId,
  ompProcessCommand,
  ompProcessOsPid,
  ompSubagentOperation,
  ompSubagentResultSummary,
  ompSubagentSpawnSpecs,
} from "./omp-subagent.js";
import { readOmpDaemonTail } from "./omp-daemon-logs.js";
export interface OmpSessionHistory {
  entries: JsonObject[];
  leafId: string | null;
}

export interface OmpHistoryState {
  sessionId: string;
  model: OmpNativeModelRef | null;
  cwd?: string;
}

interface OmpEntry extends JsonObject {
  id: string;
  parentId: string | null;
  type: string;
}

const ompHarnessId: HarnessId = harnessIdSchema.parse("omp");

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

function validatedEntry(value: JsonObject): OmpEntry {
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    typeof value.type !== "string"
  ) {
    throw new Error("Omp history contains an invalid Entry identity");
  }
  return value as OmpEntry;
}

export function activeOmpEntries(history: OmpSessionHistory): OmpEntry[] {
  if (history.leafId === null) return [];
  const byId = new Map(
    history.entries.map((value) => {
      const entry = validatedEntry(value);
      return [entry.id, entry] as const;
    }),
  );
  const reversed: OmpEntry[] = [];
  const visited = new Set<string>();
  let current: string | null = history.leafId;
  while (current !== null) {
    if (visited.has(current)) throw new Error("Omp history active branch contains a cycle");
    visited.add(current);
    const entry = byId.get(current);
    if (!entry) throw new Error("Omp history active branch references a missing Entry");
    reversed.push(entry);
    current = entry.parentId;
  }
  return reversed.reverse();
}
function parseEntryTimestamp(entry: OmpEntry | undefined): number | undefined {
  if (!entry) return undefined;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
    return entry.timestamp;
  }
  const msg = message(entry);
  if (msg) {
    if (typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) {
      return msg.timestamp;
    }
    if (typeof msg.timestamp === "string") {
      const parsed = Date.parse(msg.timestamp);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function message(entry: OmpEntry): Record<string, unknown> | null {
  return entry.type === "message" && isRecord(entry.message) ? entry.message : null;
}

function messageRole(entry: OmpEntry): string | null {
  const value = message(entry)?.role;
  return typeof value === "string" ? value : null;
}

function itemId(entryId: string, kind: string, ordinal: number) {
  return hostItemIdSchema.parse(`omp-item-v1-${entryId}-${kind}-${ordinal}`);
}

function assistantOutcome(entries: OmpEntry[]): HistoricalTurnOutcome {
  const assistants = entries
    .map((entry) => message(entry))
    .filter((value): value is Record<string, unknown> => value?.role === "assistant");
  const final = assistants.at(-1);
  if (!final) return { status: "unknown", reason: "Omp history has no Assistant terminal" };
  const stopReason = final.stopReason;
  if (stopReason === "aborted") {
    return { status: "cancelled", reason: "Omp Assistant was aborted" };
  }
  if (stopReason === "error") {
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message:
          typeof final.errorMessage === "string" && final.errorMessage.length > 0
            ? final.errorMessage
            : "Omp Assistant failed",
        retryable: false,
      },
    };
  }
  if (typeof stopReason === "string" || textContent(final.content).length > 0) {
    return { status: "succeeded" };
  }
  return { status: "unknown", reason: "Omp history terminal outcome is unspecified" };
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

function extractYieldText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const result =
    value.result !== undefined ? value.result : value.data !== undefined ? value.data : value;
  if (typeof result === "string" && result.trim().length > 0) return result.trim();
  if (isRecord(result)) {
    const nested = isRecord(result.data) ? result.data : result;
    const summary =
      (typeof nested.summary === "string" && nested.summary.trim().length > 0
        ? nested.summary.trim()
        : undefined) ??
      (typeof nested.message === "string" && nested.message.trim().length > 0
        ? nested.message.trim()
        : undefined) ??
      (typeof nested.text === "string" && nested.text.trim().length > 0
        ? nested.text.trim()
        : undefined) ??
      (typeof nested.output === "string" && nested.output.trim().length > 0
        ? nested.output.trim()
        : undefined);
    if (summary) return summary;
    return JSON.stringify(result, null, 2);
  }
  return null;
}
function snapshotItems(
  entries: OmpEntry[],
  outcome: HistoricalTurnOutcome,
  cwd?: string,
): HostItemSnapshot[] {
  const snapshots: HostItemSnapshot[] = [];
  const toolStarts = new Map<string, number>();
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === "tool_execution_start" &&
      isRecord(entry.data)
    ) {
      const toolCallId =
        typeof entry.data.toolCallId === "string" ? entry.data.toolCallId : undefined;
      const startedAtStr =
        typeof entry.data.startedAt === "string" ? entry.data.startedAt : undefined;
      const startedAt = startedAtStr ? Date.parse(startedAtStr) : parseEntryTimestamp(entry);
      if (toolCallId && startedAt !== undefined && Number.isFinite(startedAt)) {
        toolStarts.set(toolCallId, startedAt);
      }
    }
  }
  const toolCalls = new Map<
    string,
    { entry: OmpEntry; entryId: string; ordinal: number; name: string; arguments: JsonValue }
  >();
  for (const entry of entries) {
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
        if (part.name === "yield") {
          const yieldText = extractYieldText(parsedArguments.data);
          if (yieldText && !projectedText) {
            const item: HostAgentMessageItem = {
              type: "agentMessage",
              itemId: itemId(entry.id, "assistant", 0),
              text: yieldText,
            };
            snapshots.push({ item, outcome: itemOutcome(outcome) });
            projectedText = true;
            continue;
          }
        }
        toolCalls.set(part.id, {
          entry,
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
    if (!call || call.name !== nativeMessage.toolName) {
      if (
        nativeMessage.toolName === "yield" &&
        !snapshots.some((s) => s.item.type === "agentMessage")
      ) {
        const yieldText =
          extractYieldText(nativeMessage.details) ?? textContent(nativeMessage.content);
        if (yieldText) {
          const item: HostAgentMessageItem = {
            type: "agentMessage",
            itemId: itemId(entry.id, "assistant", 0),
            text: yieldText,
          };
          snapshots.push({ item, outcome: itemOutcome(outcome) });
        }
      }
      continue;
    }
    if (call.name === "yield") {
      if (!snapshots.some((s) => s.item.type === "agentMessage")) {
        const yieldText =
          extractYieldText(nativeMessage.details) ??
          extractYieldText(call.arguments) ??
          textContent(nativeMessage.content);
        if (yieldText) {
          const item: HostAgentMessageItem = {
            type: "agentMessage",
            itemId: itemId(entry.id, "assistant", 0),
            text: yieldText,
          };
          snapshots.push({ item, outcome: itemOutcome(outcome) });
        }
      }
      continue;
    }
    const output = toolOutput(nativeMessage.content);
    const startMs = toolStarts.get(nativeMessage.toolCallId) ?? parseEntryTimestamp(call.entry);
    const endMs = parseEntryTimestamp(entry);
    const durationMs =
      startMs !== undefined && endMs !== undefined ? Math.max(0, endMs - startMs) : undefined;
    const toolSucceeded = nativeMessage.isError === false;
    const nativeId =
      ompNativeSubagentId(nativeMessage.details) ??
      ompNativeSubagentId(nativeMessage.content) ??
      ompNativeSubagentId(call.arguments);
    const isProcess = isOmpProcessTool(call.name, call.arguments) || isOmpProcessId(nativeId);
    if (!isProcess && ompSubagentOperation(call.name, call.arguments) === "spawn") {
      const specs = ompSubagentSpawnSpecs(call.arguments, call.name);
      const primary = specs[0];
      const resultSummary = ompSubagentResultSummary(nativeMessage.details, nativeMessage.content);
      const item: HostSubagentDelegationItem = {
        type: "subagentDelegation",
        itemId: itemId(call.entryId, "subagent", call.ordinal),
        operation: "spawn",
        ...(primary?.prompt ? { prompt: primary.prompt } : {}),
        subagents: specs.map((spec, index) => {
          const specId =
            spec.nativeSubagentId ??
            nativeId ??
            (index === 0 ? call.entry.id : `${call.entry.id}:${index}`);
          return {
            subagentId: specId,
            nativeSubagentId: specId,
            description: spec.description,
            ...(spec.role ? { role: spec.role } : {}),
            ...(spec.model ? { model: spec.model } : {}),
            ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
            background: spec.background,
            status: toolSucceeded ? "completed" : "failed",
            ...(resultSummary ? { resultSummary } : {}),
          };
        }),
      };
      snapshots.push({
        item,
        outcome: toolSucceeded
          ? { status: "succeeded" }
          : {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: `Omp Subagent '${call.name}' failed`,
                retryable: false,
              },
            },
      });
      continue;
    }
    if (isProcess) {
      const processId = nativeId ?? call.entry.id;
      const osPid =
        ompProcessOsPid(nativeMessage.details) ??
        ompProcessOsPid(nativeMessage.content) ??
        ompProcessOsPid(call.arguments);
      const rawOutput = output ? textContent(nativeMessage.content) : undefined;
      const daemonLogOutput = processId && cwd ? readOmpDaemonTail(cwd, processId) : null;
      const processOutput = daemonLogOutput ?? rawOutput;
      const item: HostCommandExecutionItem = {
        type: "commandExecution",
        itemId: itemId(call.entryId, "process", call.ordinal),
        command: ompProcessCommand(call.name, call.arguments),
        processId,
        ...(osPid !== undefined ? { osPid } : {}),
        ...(processOutput ? { output: processOutput } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      snapshots.push({
        item,
        outcome: toolSucceeded
          ? { status: "succeeded" }
          : {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: `Omp Process '${call.name}' failed`,
                retryable: false,
              },
            },
      });
      continue;
    }
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: itemId(call.entryId, "tool", call.ordinal),
      toolName: call.name,
      arguments: call.arguments,
      ...(output ? { output } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
    snapshots.push({
      item,
      outcome: toolSucceeded
        ? { status: "succeeded" }
        : {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: `Omp Tool '${call.name}' failed`,
              retryable: false,
            },
          },
    });
  }
  return snapshots;
}

function modelChange(entry: OmpEntry): OmpNativeModelRef | null {
  return entry.type === "model_change" &&
    typeof entry.provider === "string" &&
    typeof entry.modelId === "string"
    ? { provider: entry.provider, id: entry.modelId }
    : null;
}

export function mapOmpSnapshot(
  history: OmpSessionHistory,
  state: OmpHistoryState,
): HostThreadSnapshot {
  const active = activeOmpEntries(history);
  const turns: HostThreadSnapshot["turns"] = [];
  let effectiveModel = state.model;
  for (let index = 0; index < active.length;) {
    const model = modelChange(active[index] as OmpEntry);
    if (model) {
      effectiveModel = model;
      index += 1;
      continue;
    }
    const user = active[index] as OmpEntry;
    if (messageRole(user) !== "user") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < active.length) {
      const next = active[end] as OmpEntry;
      if (messageRole(next) === "user" && message(next)?.steering !== true) break;
      end += 1;
    }
    const entries = active.slice(index, end);
    const outcome = assistantOutcome(entries);
    const userText = textContent(message(user)?.content);
    const startedAt = parseEntryTimestamp(user);
    const lastEntry = entries[entries.length - 1];
    const completedAt = parseEntryTimestamp(lastEntry);
    const durationMs =
      startedAt !== undefined && completedAt !== undefined
        ? Math.max(0, completedAt - startedAt)
        : undefined;
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: ompHarnessId,
      nativeSessionId: state.sessionId,
      nativeTurnKey: user.id,
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: ompHarnessId,
      nativeSessionId: state.sessionId,
      checkpointId: user.id,
      formatVersion: 1,
    }) as NativeCheckpointRef;
    turns.push({
      nativeTurnRef,
      checkpoint,
      input: [{ type: "text", text: userText }],
      items: snapshotItems(entries, outcome, state.cwd),
      outcome,
      ...(effectiveModel ? { model: encodeOmpModelRef(effectiveModel) } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    for (const entry of entries) {
      const changed = modelChange(entry);
      if (changed) effectiveModel = changed;
    }
    index = end;
  }
  return { turns };
}

export function resolveOmpLastTurnBoundary(
  history: OmpSessionHistory,
): { lastUserEntryId: string; sourceTurnCount: number } | null {
  const users = activeOmpEntries(history).filter((entry) => messageRole(entry) === "user");
  const last = users.at(-1);
  return last ? { lastUserEntryId: last.id, sourceTurnCount: users.length } : null;
}

export function resolveOmpForkBoundary(
  history: OmpSessionHistory,
  checkpointId: string,
): { targetTurnIndex: number; nextUserEntryId: string | null } {
  const active = activeOmpEntries(history);
  const users = active.filter((entry) => messageRole(entry) === "user");
  const targetTurnIndex = users.findIndex((entry) => entry.id === checkpointId);
  if (targetTurnIndex < 0) throw new Error("Omp Checkpoint is not on the active branch");
  return {
    targetTurnIndex,
    nextUserEntryId: users[targetTurnIndex + 1]?.id ?? null,
  };
}
