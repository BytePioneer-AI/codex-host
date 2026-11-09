import type {
  HostEvent,
  HostSubagentDelegationItem,
  HostSubagentState,
  HostSubagentStatus,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";
import { GOTGENES_PREFIX, GOTGENES_WIDGET } from "./pi-gotgenes-extension.js";

const PREFIX = "pi-gotgenes-v1:";
const STATUSES: Record<string, HostSubagentStatus> = {
  queued: "pending",
  running: "running",
  background: "pending",
  completed: "completed",
  aborted: "interrupted",
  stopped: "interrupted",
  error: "failed",
};
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, limit = 2048): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}
export function gotgenesId(id: string): string {
  return PREFIX + Buffer.from(id).toString("base64url");
}
export function parseGotgenesId(value: string): string | null {
  if (!value.startsWith(PREFIX)) return null;
  const id = Buffer.from(value.slice(PREFIX.length), "base64url").toString("utf8");
  if (!text(id, 256) || /[\s/\\]/u.test(id) || gotgenesId(id) !== value)
    throw new Error("Invalid gotgenes subagent identity");
  return id;
}
/** Native run owning an observation; never infer a Host Turn from delivery timing. */
export type GotgenesObservationOwner = "requested" | "autonomous" | "idle";

export interface GotgenesRecord {
  id: string;
  child: HostSubagentState;
  outputFile?: string | undefined;
  revision?: string;
  roleKnown: boolean;
  backgroundKnown: boolean;
}
export function gotgenesRecord(value: unknown): GotgenesRecord | null {
  if (
    !isRecord(value) ||
    !text(value.id, 256) ||
    /[\s/\\]/u.test(value.id) ||
    !text(value.type) ||
    !text(value.description) ||
    typeof value.status !== "string" ||
    !Object.hasOwn(STATUSES, value.status)
  )
    return null;
  const status = STATUSES[value.status];
  if (!status) return null;
  const id = gotgenesId(value.id);
  const progress = typeof value.toolUses === "number" ? `${value.toolUses} tool uses` : undefined;
  const result =
    typeof value.error === "string"
      ? value.error
      : typeof value.result === "string"
        ? value.result
        : progress;
  return {
    id: value.id,
    roleKnown: value.roleKnown !== false,
    backgroundKnown: typeof value.isBackground === "boolean",
    child: {
      subagentId: id,
      nativeSubagentId: id,
      description: value.description,
      role: value.type,
      status,
      background: value.isBackground === true,
      ...(text(value.modelName) ? { model: value.modelName } : {}),
      ...(result ? { resultSummary: result.slice(0, 2048) } : {}),
    },
    ...(text(value.outputFile, 8192) ? { outputFile: value.outputFile } : {}),
    revision: JSON.stringify([
      value.toolUses,
      value.turnBudget,
      value.lifetimeUsage,
      value.outputFile,
    ]),
  };
}
export function gotgenesToolRecord(toolName: string, result: unknown): GotgenesRecord | null {
  if (
    !["subagent", "get_subagent_result"].includes(toolName) ||
    !isRecord(result) ||
    !isRecord(result.details)
  )
    return null;
  const d = result.details;
  // Distinguish the plugin's structured details from other tools with the same name.
  if (!text(d.agentId, 256) || !text(d.displayName) || !text(d.description)) return null;
  return gotgenesRecord({
    ...d,
    id: d.agentId,
    type: d.subagentType ?? d.displayName,
    roleKnown: text(d.subagentType),
    isBackground:
      toolName === "subagent"
        ? d.status === "background" || (Array.isArray(d.tags) && d.tags.includes("background"))
        : undefined,
    outputFile: d.transcriptPath,
    result: d.preview,
  });
}
export function parseGotgenesWidget(value: unknown): GotgenesRecord[] | null {
  if (
    !isRecord(value) ||
    value.type !== "extension_ui_request" ||
    value.method !== "setWidget" ||
    value.widgetKey !== GOTGENES_WIDGET ||
    !Array.isArray(value.widgetLines)
  )
    return null;
  const line = value.widgetLines.find(
    (x): x is string => typeof x === "string" && x.startsWith(GOTGENES_PREFIX),
  );
  if (!line || Buffer.byteLength(line) > 1024 * 1024) return null;
  try {
    const payload: unknown = JSON.parse(line.slice(GOTGENES_PREFIX.length));
    if (
      !isRecord(payload) ||
      payload.version !== 1 ||
      !Array.isArray(payload.agents) ||
      payload.agents.length > 128
    )
      return null;
    const records = payload.agents.map(gotgenesRecord);
    return records.every((r) => r !== null) ? records : null;
  } catch {
    return null;
  }
}

/** Query receipts omit role/background; omission must not overwrite an observed native value. */
export function mergeGotgenesRecord(
  previous: GotgenesRecord | undefined,
  record: GotgenesRecord,
): GotgenesRecord {
  const model = record.child.model ?? previous?.child.model;
  const role = record.roleKnown ? record.child.role : (previous?.child.role ?? record.child.role);
  return {
    ...previous,
    ...record,
    roleKnown: record.roleKnown || previous?.roleKnown === true,
    backgroundKnown: record.backgroundKnown || previous?.backgroundKnown === true,
    outputFile: record.outputFile ?? previous?.outputFile,
    child: {
      ...previous?.child,
      ...record.child,
      ...(model ? { model } : {}),
      ...(role ? { role } : {}),
      background: record.backgroundKnown
        ? record.child.background
        : (previous?.child.background ?? record.child.background),
    },
  };
}

/** Observe native workers without inventing lifecycle from parent completion. */
export class GotgenesSubagents {
  readonly records = new Map<string, GotgenesRecord>();
  readonly #nativeObserved = new Set<string>();
  readonly #active = new Map<string, { turnId: HostTurnId; item: HostSubagentDelegationItem }>();
  constructor(private readonly emit: (event: HostEvent) => void) {}
  observe(
    records: GotgenesRecord[],
    publish = true,
    activeTurn?: { turnId: HostTurnId; nextItemId: () => HostItemId },
    nativeObservation = false,
  ): void {
    for (const record of records) {
      // A parent history receipt can lag a live background run (especially after resume).
      if (!publish && this.#nativeObserved.has(record.id)) continue;
      if (nativeObservation) this.#nativeObserved.add(record.id);
      const previous = this.records.get(record.id);
      const merged = mergeGotgenesRecord(previous, record);
      this.records.set(record.id, merged);
      if (publish && !previous && activeTurn && !this.#active.has(record.id)) {
        const item: HostSubagentDelegationItem = {
          type: "subagentDelegation",
          itemId: activeTurn.nextItemId(),
          operation: "spawn",
          subagents: [merged.child],
        };
        this.#active.set(record.id, { turnId: activeTurn.turnId, item });
        this.emit({ type: "item.started", turnId: activeTurn.turnId, item });
      }
      if (!publish || JSON.stringify(previous) === JSON.stringify(merged)) continue;
      const active = this.#active.get(record.id);
      if (active) {
        active.item = { ...active.item, subagents: [merged.child] };
        this.emit({
          type: "item.updated",
          turnId: active.turnId,
          itemId: active.item.itemId,
          update: { type: "subagents.replace", subagents: [merged.child] },
        });
      }
      this.emit({
        type: "subagent.state.changed",
        nativeSubagentId: merged.child.subagentId,
        status: merged.child.status,
      });
      this.emit({ type: "subagent.transcript.changed", nativeSubagentId: merged.child.subagentId });
    }
  }
  project(
    toolName: string,
    result: unknown,
    itemId: HostItemId,
  ): HostSubagentDelegationItem | null {
    const parsed = gotgenesToolRecord(toolName, result);
    if (!parsed || toolName !== "subagent") return null;
    const child = this.records.get(parsed.id)?.child ?? parsed.child;
    return { type: "subagentDelegation", itemId, operation: "spawn", subagents: [child] };
  }
  start(turnId: HostTurnId, toolName: string, result: unknown, itemId: HostItemId): boolean {
    const parsed = gotgenesToolRecord(toolName, result);
    if (!parsed) return false;
    // Service state is authoritative: receipts can describe a launch or a previous resumed run.
    const prior = this.records.get(parsed.id);
    if (!prior || !this.#nativeObserved.has(parsed.id)) this.observe([parsed]);
    else {
      this.observe([
        {
          ...prior,
          child: { ...prior.child, ...(parsed.child.model ? { model: parsed.child.model } : {}) },
        },
      ]);
    }
    if (toolName === "subagent" && !this.#active.has(parsed.id)) {
      const item = this.project(toolName, result, itemId);
      if (!item) return false;
      this.#active.set(parsed.id, { turnId, item });
      this.emit({ type: "item.started", turnId, item });
    }
    return true;
  }
  finish(turnId: HostTurnId): void {
    for (const [id, active] of this.#active) {
      if (active.turnId !== turnId) continue;
      this.#active.delete(id);
      this.emit({
        type: "item.completed",
        turnId,
        snapshot: { item: active.item, outcome: { status: "succeeded" } },
      });
    }
  }
}
