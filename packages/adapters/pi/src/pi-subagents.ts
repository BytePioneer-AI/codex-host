import { createHash } from "node:crypto";

import type {
  HostEvent,
  HostSubagentDelegationItem,
  HostSubagentState,
  HostSubagentStatus,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeTurnRefSchema,
  type HostItemId,
  type HostTurnId,
} from "@codexhost/shared-contracts";

import { piWorkflowSummary, projectPiWorkflow } from "./pi-subagent-workflow.js";

const STATUS_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const INSPECT_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";
const ID_PREFIX = "pi-subagents-v1:";
const MAX_BYTES = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.startsWith("--") &&
    !/\s/u.test(value) &&
    [...value].every((character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127)
  );
}

export interface PiSubagentNode {
  id: string;
  kind: "subagent" | "workflow" | "step" | "host-step";
  label: string;
  state: string;
  children?: PiSubagentNode[];
}

const statuses: Record<string, HostSubagentStatus> = {
  queued: "pending",
  running: "running",
  complete: "completed",
  failed: "failed",
  partial: "failed",
  paused: "interrupted",
  stopped: "interrupted",
  rejected: "failed",
};

function node(value: unknown, depth: number, budget: { count: number }): PiSubagentNode | null {
  if (
    !record(value) ||
    depth > 8 ||
    ++budget.count > 256 ||
    !token(value.id) ||
    !["subagent", "workflow", "step", "host-step"].includes(String(value.kind)) ||
    typeof value.label !== "string" ||
    value.label.length > 2048 ||
    typeof value.state !== "string" ||
    !Object.hasOwn(statuses, value.state)
  )
    return null;
  const children: PiSubagentNode[] = [];
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) return null;
    for (const child of value.children) {
      const parsed = node(child, depth + 1, budget);
      if (!parsed) return null;
      children.push(parsed);
    }
  }
  return {
    id: value.id,
    kind: value.kind as PiSubagentNode["kind"],
    label: value.label,
    state: value.state,
    ...(children.length ? { children } : {}),
  };
}

function widget(value: unknown, key: string, prefix: string): Record<string, unknown> | null {
  if (
    !record(value) ||
    value.type !== "extension_ui_request" ||
    value.method !== "setWidget" ||
    value.widgetKey !== key ||
    !Array.isArray(value.widgetLines)
  )
    return null;
  const line = value.widgetLines.find(
    (part): part is string => typeof part === "string" && part.startsWith(prefix),
  );
  if (!line || Buffer.byteLength(line) > MAX_BYTES + prefix.length) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(prefix.length));
    return record(parsed) && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Only consume the plugin's versioned machine protocol, never its human-readable widget. */
export function parsePiSubagentStatus(value: unknown): PiSubagentNode[] | null {
  const parsed = widget(value, "subagent-async", STATUS_PREFIX);
  if (
    !parsed ||
    parsed.kind !== "pi-subagents.async-status-snapshot" ||
    !Array.isArray(parsed.runs)
  )
    return null;
  const runs: PiSubagentNode[] = [];
  const budget = { count: 0 };
  for (const run of parsed.runs) {
    const parsedNode = node(run, 0, budget);
    if (!parsedNode) return null;
    runs.push(parsedNode);
  }
  return runs;
}

export interface PiSubagentAddress {
  runId: string;
  childId?: string;
}

export function piSubagentId(address: PiSubagentAddress): string {
  return (
    ID_PREFIX +
    Buffer.from(JSON.stringify([address.runId, address.childId ?? null])).toString("base64url")
  );
}

export function parsePiSubagentId(id: string): PiSubagentAddress {
  if (!id.startsWith(ID_PREFIX) || id.length > 1500)
    throw new Error("Invalid Pi Subagent identity");
  const value: unknown = JSON.parse(
    Buffer.from(id.slice(ID_PREFIX.length), "base64url").toString("utf8"),
  );
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !token(value[0]) ||
    (value[1] !== null && !token(value[1]))
  )
    throw new Error("Invalid Pi Subagent identity");
  const address = { runId: value[0], ...(value[1] === null ? {} : { childId: value[1] }) };
  if (piSubagentId(address) !== id) throw new Error("Non-canonical Pi Subagent identity");
  return address;
}

function states(run: PiSubagentNode): HostSubagentState[] {
  const result: HostSubagentState[] = [];
  const seen = new Set<string>();
  const visit = (entry: PiSubagentNode, root: boolean): void => {
    if (entry.kind === "host-step" || (!root && entry.kind === "workflow")) return;
    // Workflow containers are not child Agents. Inspectable leaves use the exact snapshot node id.
    if (entry.kind !== "workflow") {
      const id = piSubagentId({ runId: run.id, ...(!root ? { childId: entry.id } : {}) });
      if (!seen.has(id)) {
        seen.add(id);
        result.push({
          subagentId: id,
          nativeSubagentId: id,
          description: entry.label,
          background: true,
          status: statuses[entry.state] ?? "running",
        });
      }
    }
    for (const child of entry.children ?? []) {
      // A single run's step is the same worker, not a second Agent identity.
      if (entry.kind === "subagent" && child.kind === "step") {
        for (const nested of child.children ?? []) visit(nested, false);
      } else visit(child, false);
    }
  };
  visit(run, true);
  return result;
}

function asyncRunId(toolName: string, result: unknown): string | null {
  if (toolName !== "subagent" || !record(result) || !record(result.details)) return null;
  const details = result.details;
  // Management/status calls are not launches. Recognition additionally requires a versioned widget.
  return ["single", "parallel", "chain", "workflow"].includes(String(details.mode)) &&
    token(details.asyncId) &&
    typeof details.asyncDir === "string"
    ? details.asyncId
    : null;
}

/** Pi-specific observation only. Tool/parent completion never settles background children. */
export class PiSubagents {
  readonly #children = new Map<string, Map<string, HostSubagentState>>();
  readonly #active = new Map<string, { turnId: HostTurnId; item: HostSubagentDelegationItem }>();
  readonly #waiting = new Map<string, { turnId: HostTurnId; itemId: HostItemId }>();

  constructor(private readonly emit: (event: HostEvent) => void) {}

  observe(runs: PiSubagentNode[]): void {
    this.#apply(runs, true);
  }

  restore(runs: PiSubagentNode[]): void {
    this.#apply(runs, false);
  }

  #apply(runs: PiSubagentNode[], publish: boolean): void {
    // Snapshots are bounded: absence is not completion, cancellation, or deletion.
    for (const run of runs) {
      const observed = states(run);
      const retained = this.#children.get(run.id) ?? new Map<string, HostSubagentState>();
      for (const child of observed) retained.set(child.subagentId, child);
      this.#children.set(run.id, retained);
      const children = [...retained.values()];
      if (!publish) continue;
      const waiting = this.#waiting.get(run.id);
      if (waiting && children.length) {
        const item: HostSubagentDelegationItem = {
          type: "subagentDelegation",
          itemId: waiting.itemId,
          operation: "spawn",
          subagents: children,
        };
        this.#waiting.delete(run.id);
        this.#active.set(run.id, { turnId: waiting.turnId, item });
        this.emit({ type: "item.started", turnId: waiting.turnId, item });
      }
      const active = this.#active.get(run.id);
      if (active && children.length) {
        // Keep omitted children when a bounded snapshot contains only part of a workflow.
        const merged = new Map(
          active.item.subagents.map((child) => [child.nativeSubagentId, child]),
        );
        for (const child of children) merged.set(child.nativeSubagentId, child);
        active.item = { ...active.item, subagents: [...merged.values()] };
        this.emit({
          type: "item.updated",
          turnId: active.turnId,
          itemId: active.item.itemId,
          update: { type: "subagents.replace", subagents: active.item.subagents },
        });
      }
      for (const child of observed) {
        this.emit({
          type: "subagent.state.changed",
          nativeSubagentId: child.subagentId,
          status: child.status,
        });
        this.emit({ type: "subagent.transcript.changed", nativeSubagentId: child.subagentId });
      }
    }
  }

  project(
    toolName: string,
    result: unknown,
    itemId: HostItemId,
    callId?: string,
  ): HostSubagentDelegationItem | null {
    const workflow = toolName === "subagent" ? piWorkflowSummary(result) : null;
    if (workflow && (!callId || workflow.parentToolCallId === callId))
      return projectPiWorkflow(workflow, itemId);
    const runId = asyncRunId(toolName, result);
    if (!runId || !this.#children.has(runId)) return null;
    const children = [...(this.#children.get(runId)?.values() ?? [])];
    return children.length
      ? { type: "subagentDelegation", itemId, operation: "spawn", subagents: children }
      : null;
  }

  start(
    turnId: HostTurnId,
    toolName: string,
    result: unknown,
    itemId: HostItemId,
    callId?: string,
  ): void {
    const workflow = toolName === "subagent" ? piWorkflowSummary(result) : null;
    if (workflow && (!callId || workflow.parentToolCallId === callId)) {
      const key = `workflow:${workflow.workflowRunId}`;
      const previous = this.#active.get(key);
      const item = projectPiWorkflow(workflow, previous?.item.itemId ?? itemId);
      if (!item) return;
      if (previous) {
        const children = new Map(
          previous.item.subagents.map((child) => [child.nativeSubagentId, child]),
        );
        for (const child of item.subagents) children.set(child.nativeSubagentId, child);
        item.subagents = [...children.values()];
        previous.item = item;
        this.emit({
          type: "item.updated",
          turnId: previous.turnId,
          itemId: item.itemId,
          update: { type: "subagents.replace", subagents: item.subagents },
        });
      } else {
        this.#active.set(key, { turnId, item });
        this.emit({ type: "item.started", turnId, item });
      }
      for (const child of item.subagents) {
        this.emit({
          type: "subagent.state.changed",
          nativeSubagentId: child.subagentId,
          status: child.status,
        });
        this.emit({ type: "subagent.transcript.changed", nativeSubagentId: child.subagentId });
      }
      return;
    }
    const runId = asyncRunId(toolName, result);
    const item = this.project(toolName, result, itemId);
    if (!runId || this.#active.has(runId)) return;
    if (!item) {
      this.#waiting.set(runId, { turnId, itemId });
      return;
    }
    this.#active.set(runId, { turnId, item });
    this.emit({ type: "item.started", turnId, item });
  }

  finish(turnId: HostTurnId): void {
    for (const [runId, waiting] of this.#waiting) {
      if (waiting.turnId === turnId) this.#waiting.delete(runId);
    }
    for (const [runId, active] of this.#active) {
      if (active.turnId !== turnId) continue;
      this.#active.delete(runId);
      // This is the observation/delegation Item's outcome, not the child's execution outcome.
      this.emit({
        type: "item.completed",
        turnId,
        snapshot: { item: active.item, outcome: { status: "succeeded" } },
      });
    }
  }
}

export interface PiSubagentInspection {
  kind: "pi-subagents.inspect-reply";
  version: 1;
  requestId: string;
  asyncId?: string;
  childId?: string;
  status?: string;
  task?: string;
  messages?: { role: string; kind: string; text: string; name?: string }[];
  finalOutput?: string;
  truncated?: { task: boolean; messages: number; finalOutput: boolean };
  error?: { code: string; message: string };
}

export function parsePiSubagentInspection(value: unknown): PiSubagentInspection | null {
  const parsed = widget(value, "subagent-inspect", INSPECT_PREFIX);
  if (!parsed || parsed.kind !== "pi-subagents.inspect-reply" || !token(parsed.requestId))
    return null;
  if (
    parsed.error !== undefined &&
    (!record(parsed.error) ||
      typeof parsed.error.code !== "string" ||
      typeof parsed.error.message !== "string")
  )
    return null;
  for (const field of ["asyncId", "childId", "status", "task", "finalOutput"]) {
    if (parsed[field] !== undefined && typeof parsed[field] !== "string") return null;
  }
  if (
    parsed.messages !== undefined &&
    (!Array.isArray(parsed.messages) ||
      parsed.messages.length > 200 ||
      parsed.messages.some(
        (entry) =>
          !record(entry) ||
          typeof entry.role !== "string" ||
          typeof entry.text !== "string" ||
          !["text", "toolCall", "toolResult"].includes(String(entry.kind)) ||
          (entry.name !== undefined && typeof entry.name !== "string"),
      ))
  )
    return null;
  if (
    parsed.truncated !== undefined &&
    (!record(parsed.truncated) ||
      typeof parsed.truncated.task !== "boolean" ||
      typeof parsed.truncated.finalOutput !== "boolean" ||
      !Number.isSafeInteger(parsed.truncated.messages) ||
      Number(parsed.truncated.messages) < 0)
  )
    return null;
  return parsed as unknown as PiSubagentInspection;
}

/** A bounded native transcript window, not a fabricated resumable child Session. */
export function piSubagentSnapshot(
  parentSessionId: string,
  id: string,
  reply: PiSubagentInspection,
): HostThreadSnapshot {
  const messages = reply.messages ?? [];
  const texts = messages.map((entry) =>
    entry.kind === "text" && entry.role === "assistant"
      ? entry.text
      : `[${entry.role}${entry.name ? `: ${entry.name}` : ""} / ${entry.kind}]\n${entry.text}`,
  );
  if (!texts.length && reply.finalOutput) texts.push(reply.finalOutput);
  if (
    reply.truncated &&
    (reply.truncated.task || reply.truncated.messages || reply.truncated.finalOutput)
  ) {
    texts.push("[Pi subagent: native inspection returned a truncated transcript window.]");
  }
  return {
    turns: [
      {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: "pi",
          nativeSessionId: parentSessionId,
          nativeTurnKey: `pi-subagent-${createHash("sha256").update(id).digest("hex")}`,
          formatVersion: 1,
        }),
        input: reply.task ? [{ type: "text", text: reply.task }] : [],
        items: texts.map((text, index) => ({
          item: {
            type: "agentMessage",
            text,
            itemId: hostItemIdSchema.parse(
              `pi-subagent-${createHash("sha256").update(`${id}:${index}:${text}`).digest("hex")}`,
            ),
          },
          outcome: { status: "succeeded" },
        })),
        outcome:
          reply.status === "complete"
            ? { status: "succeeded" }
            : reply.status === "stopped"
              ? { status: "cancelled", reason: "Pi subagent stopped" }
              : ["failed", "partial", "rejected"].includes(reply.status ?? "")
                ? {
                    status: "failed",
                    error: {
                      code: "nativeFailure",
                      message: `Pi subagent ${reply.status}`,
                      retryable: false,
                    },
                  }
                : {
                    status: "unknown",
                    reason: `Pi subagent ${reply.status ?? "status unavailable"}`,
                  },
      },
    ],
  };
}
