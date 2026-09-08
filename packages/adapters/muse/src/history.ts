import type {
  HistoricalTurnOutcome,
  HostItem,
  HostItemOutcome,
  HostSubagentState,
  HostSubagentStatus,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeTurnRefSchema,
  type JsonValue,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import type { JsonObject, MuseRpc } from "./msp-client.js";
import { MuseRpcError } from "./msp-client.js";

/** MSP Item text: user/agent use `text`; other kinds fall back to visible surfaces. */
export function museItemText(item: JsonObject): string {
  if (typeof item.text === "string" && item.text) return item.text;
  if (typeof item.displayText === "string" && item.displayText) return item.displayText;
  if (typeof item.fallbackText === "string" && item.fallbackText) return item.fallbackText;
  if (typeof item.visibleOutput === "string" && item.visibleOutput) return item.visibleOutput;
  if (typeof item.message === "string" && item.message) return item.message;
  if (typeof item.result === "string" && item.result) return item.result;
  if (Array.isArray(item.summary)) {
    return item.summary.filter((part): part is string => typeof part === "string").join("\n");
  }
  return "";
}

function itemId(item: JsonObject, fallback: string): string {
  return typeof item.itemId === "string" && item.itemId.trim() ? item.itemId : fallback;
}

/** The native turn owns steered inputs too; their submitting command IDs may differ. */
export function museNativeTurnKey(item: JsonObject, fallbackIndex: number): string {
  if (typeof item.turnId === "string" && item.turnId.trim()) return item.turnId;
  if (typeof item.commandId === "string" && item.commandId.trim()) return item.commandId;
  if (typeof item.itemId === "string" && item.itemId.trim()) return item.itemId;
  return `turn:${fallbackIndex}`;
}

export function snapshotFromMuseHistory(
  nativeRef: NativeSessionRef,
  history: JsonObject | undefined,
): HostThreadSnapshot {
  const rawItems = Array.isArray(history?.items) ? history.items.filter(isRecord) : [];
  const turns: HostTurnSnapshot[] = [];
  const turnsById = new Map<string, HostTurnSnapshot>();
  let current: HostTurnSnapshot | undefined;
  let index = 0;
  for (const item of rawItems) {
    const kind = typeof item.kind === "string" ? item.kind : "";
    const nativeTurnKey =
      kind === "userMessage" || (typeof item.turnId === "string" && item.turnId.trim())
        ? museNativeTurnKey(item, index)
        : (current?.nativeTurnRef.nativeTurnKey ?? museNativeTurnKey(item, index));
    current = turnsById.get(nativeTurnKey);
    if (!current) {
      current = {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: nativeRef.harnessId,
          nativeSessionId: nativeRef.nativeSessionId,
          nativeTurnKey,
          formatVersion: 1,
        }),
        input: [],
        items: [],
        outcome: { status: "unknown", reason: "Muse turn/completed was not available in history" },
      };
      turns.push(current);
      turnsById.set(nativeTurnKey, current);
    }
    index += 1;
    if (kind === "userMessage") {
      current.input.push({ type: "text", text: museItemText(item) });
      continue;
    }
    const mapped = mapMuseHostItem(item, `item-${index}`);
    if (mapped) current.items.push({ item: mapped, outcome: museHistoryItemOutcome(item) });
  }
  const completions = Array.isArray(history?.turnCompletions)
    ? history.turnCompletions.filter(isRecord)
    : [];
  for (const completion of completions) {
    const turn =
      typeof completion.turnId === "string" ? turnsById.get(completion.turnId) : undefined;
    if (turn) turn.outcome = museHistoryTurnOutcome(completion);
  }
  return { turns };
}

export function museHistoryTurnOutcome(completion: JsonObject): HistoricalTurnOutcome {
  const terminal = completion.terminal;
  if (terminal === "completed") return { status: "succeeded" };
  const reason = typeof completion.reason === "string" ? completion.reason : undefined;
  if (terminal === "cancelled") return { status: "cancelled", ...(reason ? { reason } : {}) };
  if (terminal === "failed") {
    const error = isRecord(completion.error) ? completion.error : undefined;
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message:
          typeof error?.message === "string" ? error.message : (reason ?? "Muse Turn failed"),
        retryable: error?.retryable === true,
      },
    };
  }
  return { status: "unknown", reason: `Unknown Muse turn terminal: ${String(terminal)}` };
}

export function museHistoryItemOutcome(item: JsonObject): HostItemOutcome {
  const reason =
    (typeof item.failureReason === "string" && item.failureReason) ||
    (typeof item.reason === "string" && item.reason) ||
    `Muse item ${String(item.status)}`;
  if (item.status === "cancelled" || item.status === "rejected") {
    return { status: "cancelled", reason };
  }
  if (item.status === "failed" || item.status === "timedOut") {
    return {
      status: "failed",
      error: { code: "nativeFailure", message: reason, retryable: false },
    };
  }
  // Host item snapshots have no unknown/in-progress outcome. Preserve visible
  // partial/legacy items; only the native turn/completed can confirm turn success.
  return { status: "succeeded" };
}

export function mapMuseHostItem(item: JsonObject, fallbackId: string): HostItem | undefined {
  const kind = typeof item.kind === "string" ? item.kind : "";
  if (kind === "userMessage") return undefined;
  const itemIdValue = hostItemIdSchema.parse(itemId(item, fallbackId));
  if (kind === "agentMessage") {
    return { type: "agentMessage", itemId: itemIdValue, text: museItemText(item) };
  }
  if (kind === "reasoning") {
    return { type: "reasoning", itemId: itemIdValue, text: museItemText(item) };
  }
  if (kind === "toolCall") {
    const output = museItemText(item);
    return {
      type: "toolExecution",
      itemId: itemIdValue,
      toolName:
        typeof item.tool === "string" && item.tool
          ? item.tool
          : typeof item.scriptId === "string" && item.scriptId
            ? item.scriptId
            : "tool",
      arguments: museToolArguments(item.args),
      ...(output ? { output: { content: [{ type: "text" as const, text: output }] } } : {}),
    };
  }
  if (kind === "userShell") {
    const output = museItemText(item);
    return {
      type: "commandExecution",
      itemId: itemIdValue,
      command: typeof item.commandText === "string" ? item.commandText : output,
      ...(output ? { output } : {}),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    };
  }
  if (kind === "compaction") {
    return { type: "contextCompaction", itemId: itemIdValue };
  }
  if (kind === "subagent") {
    const state = museSubagentState(item, itemIdValue);
    return {
      type: "subagentDelegation",
      itemId: itemIdValue,
      operation: "spawn",
      ...(typeof item.objective === "string" && item.objective ? { prompt: item.objective } : {}),
      subagents: [state],
    };
  }
  if (kind === "workflow") {
    const children = Array.isArray(item.children) ? item.children.filter(isRecord) : [];
    const subagents = children.flatMap((child) => {
      const state = workflowChildState(child);
      return state ? [state] : [];
    });
    const summary = museItemText(item);
    return {
      type: "subagentDelegation",
      itemId: itemIdValue,
      operation: "spawn",
      ...(summary ? { prompt: summary } : {}),
      subagents:
        subagents.length > 0
          ? subagents
          : [
              {
                subagentId: itemIdValue,
                nativeSubagentId: itemIdValue,
                description: summary || "Muse workflow",
                background: false,
                status: museItemStatus(item),
                ...(summary ? { resultSummary: summary } : {}),
              },
            ],
    };
  }
  if (kind) {
    return {
      type: "toolExecution",
      itemId: itemIdValue,
      toolName: kind,
      arguments: {},
      ...(museItemText(item)
        ? { output: { content: [{ type: "text" as const, text: museItemText(item) }] } }
        : {}),
    };
  }
  return undefined;
}

function museToolArguments(args: unknown): JsonValue {
  if (typeof args !== "string") return {};
  try {
    return JSON.parse(args) as JsonValue;
  } catch {
    // MSP preserves model-authored almost-JSON verbatim; do not discard it.
    return args;
  }
}

const MUSE_RECOVERING_CONTROL = new Set([
  "accepted",
  "starting",
  "running",
  "recoveryPending",
  "manualReconciliation",
]);
const MUSE_TERMINAL_CONTROL = new Set(["resultReady", "closing", "closed"]);

export function museSubagentControl(item: JsonObject): string {
  return typeof item.controlStatus === "string" ? item.controlStatus : "";
}

export function museSubagentIsRecovering(item: JsonObject): boolean {
  return MUSE_RECOVERING_CONTROL.has(museSubagentControl(item));
}

export function museSubagentIsTerminal(item: JsonObject): boolean {
  const control = museSubagentControl(item);
  if (MUSE_RECOVERING_CONTROL.has(control)) return false;
  if (MUSE_TERMINAL_CONTROL.has(control)) return true;
  const status = typeof item.status === "string" ? item.status : "";
  return status !== "" && status !== "inProgress";
}

function museResultErrorKind(result: JsonObject | undefined): string {
  if (!result || typeof result.errorKind !== "string") return "";
  const kind = result.errorKind.trim();
  if (!kind || kind === "null" || kind === "none" || kind === "undefined") return "";
  return kind;
}

function museItemStatus(item: JsonObject): HostSubagentStatus {
  const status = typeof item.status === "string" ? item.status : "";
  const control = museSubagentControl(item);
  const result = isRecord(item.result) ? item.result : undefined;
  const errorKind = museResultErrorKind(result);
  if (museSubagentIsRecovering(item)) return "running";
  if (status === "cancelled" || status === "rejected" || status === "timedOut")
    return "interrupted";
  if (status === "failed" || errorKind) return "failed";
  if (
    status === "completed" ||
    control === "closed" ||
    control === "resultReady" ||
    control === "closing"
  ) {
    return "completed";
  }
  if (status === "inProgress") return "running";
  return "pending";
}

function museSubagentSummary(item: JsonObject, status: HostSubagentStatus): string | undefined {
  const result = isRecord(item.result) ? item.result : undefined;
  const summary =
    (typeof result?.summary === "string" && result.summary.trim()) ||
    (typeof result?.text === "string" && result.text.trim()) ||
    "";
  if (summary) return summary;
  if (status !== "failed" && status !== "interrupted") return undefined;
  const reason =
    (typeof item.failureReason === "string" && item.failureReason.trim()) ||
    (typeof item.fallbackText === "string" && item.fallbackText.trim()) ||
    (typeof item.reason === "string" && item.reason.trim()) ||
    museResultErrorKind(result);
  return reason || undefined;
}

function museSubagentState(item: JsonObject, fallbackId: string): HostSubagentState {
  const durableId =
    (typeof item.subagentId === "string" && item.subagentId.trim()) ||
    (typeof item.childSessionId === "string" && item.childSessionId.trim()) ||
    fallbackId;
  const childSessionId =
    typeof item.childSessionId === "string" && item.childSessionId.trim()
      ? item.childSessionId.trim()
      : "";
  const status = museItemStatus(item);
  const summary = museSubagentSummary(item, status);
  const description =
    (typeof item.objective === "string" && item.objective.trim()) ||
    (typeof item.fallbackText === "string" && item.fallbackText.trim()) ||
    (typeof item.role === "string" && item.role.trim()) ||
    "Muse subagent";
  const role = typeof item.role === "string" && item.role.trim() ? item.role.trim() : undefined;
  const nativeSubagentId =
    (status === "failed" || status === "interrupted") && !childSessionId ? undefined : durableId;
  return {
    subagentId: durableId,
    ...(nativeSubagentId ? { nativeSubagentId } : {}),
    description,
    background: item.background === true,
    status,
    ...(role ? { role } : {}),
    ...(summary ? { resultSummary: summary } : {}),
  };
}

function workflowChildState(child: JsonObject): HostSubagentState | undefined {
  const id = typeof child.childId === "string" && child.childId.trim() ? child.childId.trim() : "";
  if (!id) return undefined;
  const terminal = typeof child.terminal === "string" ? child.terminal : "";
  const status = typeof child.status === "string" ? child.status : "";
  const hostStatus: HostSubagentStatus =
    terminal === "failed" || status === "failed"
      ? "failed"
      : terminal === "cancelled" || status === "cancelled"
        ? "interrupted"
        : terminal === "completed" || status === "completed" || status === "closed"
          ? "completed"
          : status === "running" || status === "starting"
            ? "running"
            : "pending";
  const label = typeof child.label === "string" && child.label.trim() ? child.label.trim() : id;
  return {
    subagentId: id,
    nativeSubagentId: id,
    description: label,
    background: false,
    status: hostStatus,
  };
}

export function findMuseChildSessionId(
  history: JsonObject | undefined,
  nativeId: string,
): string | undefined {
  if (!nativeId) return undefined;
  const items = Array.isArray(history?.items) ? history.items.filter(isRecord) : [];
  for (const item of items) {
    const subagentId = typeof item.subagentId === "string" ? item.subagentId : "";
    const childSessionId = typeof item.childSessionId === "string" ? item.childSessionId : "";
    const itemIdValue = typeof item.itemId === "string" ? item.itemId : "";
    if (nativeId === subagentId || nativeId === childSessionId || nativeId === itemIdValue) {
      return childSessionId || subagentId || itemIdValue;
    }
    if (!Array.isArray(item.children)) continue;
    for (const child of item.children.filter(isRecord)) {
      const childId = typeof child.childId === "string" ? child.childId : "";
      if (childId === nativeId) return childId;
    }
  }
  return undefined;
}

export async function readMuseHistory(
  rpc: MuseRpc,
  sessionId: string,
): Promise<JsonObject | undefined> {
  let read: JsonObject | undefined;
  try {
    const result = await rpc.request("session/read", { sessionId, excludeItems: false });
    if (isRecord(result.history)) read = result.history;
  } catch (error) {
    if (!(error instanceof MuseRpcError) || (error.code !== -32601 && error.code !== -32602)) {
      throw error;
    }
  }
  const paged = await pageMuseHistory(rpc, sessionId);
  return mergeMuseHistory(read, paged.items, paged.turnCompletions);
}

export function mergeMuseHistory(
  read: JsonObject | undefined,
  pagedItems: JsonObject[],
  turnCompletions: JsonObject[] = [],
): JsonObject | undefined {
  const readItems = Array.isArray(read?.items) ? read.items.filter(isRecord) : [];
  const readById = new Map(readItems.map((item) => [item.itemId, item]));
  const pagedIds = new Set(pagedItems.map((item) => item.itemId));
  const beforePagedId = new Map<unknown, JsonObject[]>();
  let pending: JsonObject[] = [];
  for (const item of readItems) {
    if (pagedIds.has(item.itemId)) {
      if (pending.length > 0) beforePagedId.set(item.itemId, pending);
      pending = [];
    } else pending.push(item);
  }
  const merged = pagedItems.flatMap((item) => [
    ...(beforePagedId.get(item.itemId) ?? []),
    latestMuseItem(readById.get(item.itemId), item),
  ]);
  // With no common anchor, retain inline history as the prefix (older servers
  // can serve only supplemental items in view/page). Otherwise append its suffix.
  if (readItems.some((item) => pagedIds.has(item.itemId))) merged.push(...pending);
  else merged.unshift(...pending);
  if (merged.length === 0 && turnCompletions.length === 0) return read;
  return {
    ...(read ?? {}),
    mode: typeof read?.mode === "string" ? read.mode : "inline",
    items: merged,
    turnCompletions,
    snapshot: read?.snapshot ?? null,
  };
}

export async function readMuseChildHistory(
  rpc: MuseRpc,
  parentSessionId: string,
  nativeSubagentId: string,
): Promise<JsonObject | undefined> {
  const direct = await readMuseHistory(rpc, nativeSubagentId);
  if (museHistoryHasVisibleItems(direct)) return direct;
  const parent = await readMuseHistory(rpc, parentSessionId);
  const childId = findMuseChildSessionId(parent, nativeSubagentId);
  if (childId && childId !== nativeSubagentId) {
    const nested = await readMuseHistory(rpc, childId);
    if (nested) return nested;
  }
  return direct;
}

async function pageMuseHistory(
  rpc: MuseRpc,
  sessionId: string,
): Promise<{ items: JsonObject[]; turnCompletions: JsonObject[] }> {
  const ordered: JsonObject[] = [];
  const turnCompletions: JsonObject[] = [];
  const indexById = new Map<string, number>();
  let cursor: string | undefined;
  try {
    for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
      const page = await rpc.request("view/page", {
        sessionId,
        direction: "forward",
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      const events = Array.isArray(page.events) ? page.events.filter(isRecord) : [];
      for (const event of events) {
        const params = isRecord(event.params) ? event.params : {};
        if (event.method === "turn/completed") turnCompletions.push(params);
        const item = isRecord(params.item) ? params.item : undefined;
        if (!item) continue;
        const id = typeof item.itemId === "string" ? item.itemId : "";
        const existing = id ? indexById.get(id) : undefined;
        if (existing !== undefined) ordered[existing] = latestMuseItem(ordered[existing], item);
        else {
          if (id) indexById.set(id, ordered.length);
          ordered.push(item);
        }
      }
      const nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : "";
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
  } catch (error) {
    if (error instanceof MuseRpcError && (error.code === -32601 || error.code === -32602)) {
      return { items: ordered, turnCompletions };
    }
    throw error;
  }
  return { items: ordered, turnCompletions };
}

function latestMuseItem(existing: JsonObject | undefined, candidate: JsonObject): JsonObject {
  if (
    existing &&
    typeof existing.revision === "number" &&
    typeof candidate.revision === "number" &&
    candidate.revision <= existing.revision
  ) {
    return existing;
  }
  return candidate;
}

function museHistoryHasVisibleItems(history: JsonObject | undefined): boolean {
  const items = Array.isArray(history?.items) ? history.items.filter(isRecord) : [];
  return items.some((item) => {
    const kind = typeof item.kind === "string" ? item.kind : "";
    return (
      kind === "userMessage" ||
      kind === "agentMessage" ||
      kind === "reasoning" ||
      kind === "toolCall" ||
      kind === "userShell" ||
      kind === "subagent" ||
      kind === "workflow"
    );
  });
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
