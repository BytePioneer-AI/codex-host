import { createHash } from "node:crypto";
import { parseHostUsage } from "@codexhost/harness-adapter";
import type {
  HostEvent,
  HostItem,
  HostItemSnapshot,
  HostItemOutcome,
  HostThreadSnapshot,
  HostTurnSnapshot,
  HostUsage,
  TurnOutcome,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  jsonValueSchema,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import { array, record, requiredText, text, TraeError } from "./protocol.js";

export function itemId(id: string) {
  return hostItemIdSchema.parse("trae-" + createHash("sha256").update(id).digest("hex"));
}
export function turnRef(sessionId: string, id: string) {
  return nativeTurnRefSchema.parse({
    harnessId: "trae",
    nativeSessionId: sessionId,
    nativeTurnKey: id,
    formatVersion: 1,
  });
}
export function checkpoint(sessionId: string, id: string) {
  return nativeCheckpointRefSchema.parse({
    harnessId: "trae",
    nativeSessionId: sessionId,
    checkpointId: id,
    formatVersion: 1,
  });
}
export function outcome(status: unknown): TurnOutcome {
  return status === "completed"
    ? { status: "succeeded" }
    : status === "interrupted"
      ? { status: "cancelled" }
      : {
          status: "failed",
          error: { code: "nativeFailure", message: "Trae Turn failed", retryable: false },
        };
}
export function itemOutcome(item: Record<string, unknown>): HostItemOutcome {
  return item.status === "failed" || item.success === false
    ? {
        status: "failed",
        error: { code: "nativeFailure", message: "Trae tool failed", retryable: false },
      }
    : item.status === "declined"
      ? { status: "cancelled" }
      : { status: "succeeded" };
}
export function projectItem(value: unknown): HostItem | null {
  const n = record(value);
  if (n.type === "commandExecution" && n.status === "backgrounded")
    throw new TraeError(
      "unsupported",
      "Detached Trae commands are not supported; the Session was stopped without claiming completion",
    );
  const id = requiredText(n.id, "item.id");
  const common = { itemId: itemId(id) };
  switch (n.type) {
    case "userMessage":
      return null;
    case "agentMessage":
      return {
        ...common,
        type: "agentMessage",
        text: text(n.text),
        ...(n.phase === "commentary" || n.phase === "final_answer" ? { phase: n.phase } : {}),
      };
    case "reasoning":
      return { ...common, type: "reasoning", text: array(n.summary).map(text).join("\n") };
    case "plan":
      return { ...common, type: "agentMessage", text: text(n.text), phase: "commentary" };
    case "contextCompaction":
      return { ...common, type: "contextCompaction" };
    case "commandExecution":
      return {
        ...common,
        type: "commandExecution",
        command: requiredText(n.command, "command"),
        cwd: text(n.cwd),
        ...(typeof n.aggregatedOutput === "string" ? { output: n.aggregatedOutput } : {}),
        ...(typeof n.exitCode === "number" ? { exitCode: n.exitCode } : {}),
        ...(typeof n.durationMs === "number" ? { durationMs: n.durationMs } : {}),
      };
    case "fileChange":
      return {
        ...common,
        type: "fileChange",
        changes: array(n.changes).map((value) => {
          const change = record(value);
          const kind = record(change.kind).type;
          if (kind !== "add" && kind !== "update" && kind !== "delete")
            throw new TraeError("protocolError", "Unsupported Trae file change kind");
          return {
            path: requiredText(change.path, "file path"),
            kind,
            unifiedDiff: requiredText(change.diff, "file diff"),
          };
        }),
      };
    default: {
      const args = jsonValueSchema.safeParse(n.arguments ?? n);
      const output = n.result ?? n.output ?? n.contentItems ?? n.agentsStates ?? n.results;
      return {
        ...common,
        type: "toolExecution",
        toolName: text(n.tool) || text(n.type) || "Trae tool",
        ...(text(n.server) ? { namespace: text(n.server) } : {}),
        arguments: args.success ? args.data : null,
        ...(output === undefined || output === null
          ? {}
          : {
              output: {
                content: [
                  {
                    type: "text" as const,
                    text: typeof output === "string" ? output : JSON.stringify(output),
                  },
                ],
              },
            }),
      };
    }
  }
}
export function historyFrom(value: unknown, sessionId: string): HostThreadSnapshot {
  const thread = record(record(value).thread);
  if (thread.id !== sessionId || !Array.isArray(thread.turns))
    throw new TraeError("protocolError", "Trae history identity mismatch");
  const turns: HostTurnSnapshot[] = thread.turns.map((value) => {
    const t = record(value);
    const id = requiredText(t.id, "turn.id");
    if (t.itemsView !== "full")
      throw new TraeError("protocolError", "Trae returned incomplete history items");
    const items = array(t.items);
    return {
      nativeTurnRef: turnRef(sessionId, id),
      ...(t.status === "completed" || t.status === "interrupted" || t.status === "failed"
        ? { checkpoint: checkpoint(sessionId, id) }
        : {}),
      input: items
        .filter((i) => record(i).type === "userMessage")
        .flatMap((i) => array(record(i).content))
        .flatMap((c) =>
          record(c).type === "text" ? [{ type: "text" as const, text: text(record(c).text) }] : [],
        ),
      items: items.flatMap((i) => {
        const projected = projectItem(i);
        return projected ? [{ item: projected, outcome: itemOutcome(record(i)) }] : [];
      }),
      outcome:
        t.status === "inProgress"
          ? { status: "unknown", reason: "Trae Turn is still running" }
          : outcome(t.status),
      ...(typeof t.startedAt === "number" ? { startedAtMs: t.startedAt * 1000 } : {}),
      ...(typeof t.completedAt === "number" ? { completedAtMs: t.completedAt * 1000 } : {}),
    };
  });
  return { turns };
}
export function usageFrom(value: unknown): HostUsage | null {
  const u = record(value);
  const total = record(u.total);
  const result: HostUsage = {};
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ] as const)
    if (Number.isSafeInteger(total[key]) && Number(total[key]) >= 0)
      result[key] = Number(total[key]);
  if (
    Number.isSafeInteger(total.cacheCreationInputTokens) &&
    Number(total.cacheCreationInputTokens) >= 0
  )
    result.cacheWriteInputTokens = Number(total.cacheCreationInputTokens);
  const last = record(u.last);
  if (
    Number.isSafeInteger(u.modelContextWindow) &&
    Number(u.modelContextWindow) > 0 &&
    Number.isSafeInteger(last.totalTokens) &&
    Number(last.totalTokens) >= 0
  ) {
    result.contextWindowTokens = Number(u.modelContextWindow);
    result.contextUsedTokens = Number(last.totalTokens);
  }
  return Object.keys(result).length ? parseHostUsage(result) : null;
}

/** One native Turn owns its Item identities. Native completions supersede streamed previews. */
export class TurnProjection {
  #items = new Map<string, { item: HostItem; done: boolean }>();
  #closed = false;
  constructor(
    readonly turnId: HostTurnId,
    readonly emit: (event: HostEvent) => void,
  ) {}
  item(value: unknown, complete: boolean): void {
    if (this.#closed) return;
    const n = record(value);
    const id = requiredText(n.id, "item.id");
    const projected = projectItem(value);
    if (!projected) return;
    let entry = this.#items.get(id);
    if (entry?.done) return;
    if (!entry) {
      entry = { item: projected, done: false };
      this.#items.set(id, entry);
      this.emit({ type: "item.started", turnId: this.turnId, item: structuredClone(projected) });
    }
    if (complete) {
      entry.item = projected;
      entry.done = true;
      this.emit({
        type: "item.completed",
        turnId: this.turnId,
        snapshot: { item: projected, outcome: itemOutcome(n) },
      });
    }
  }
  delta(method: string, params: Record<string, unknown>): void {
    if (this.#closed) return;
    const id = text(params.itemId);
    let entry = this.#items.get(id);
    const delta = text(params.delta);
    if (!id || !delta) return;
    const type =
      method === "item/agentMessage/delta"
        ? "agentMessage"
        : method === "item/reasoning/summaryTextDelta"
          ? "reasoning"
          : undefined;
    if (!entry && type) {
      this.item({ id, type, text: "", summary: [] }, false);
      entry = this.#items.get(id);
    }
    if (!entry || entry.done) return;
    let update: Extract<HostEvent, { type: "item.updated" }>["update"];
    if (type && (entry.item.type === "agentMessage" || entry.item.type === "reasoning")) {
      entry.item = { ...entry.item, text: entry.item.text + delta };
      update = { type: "text.append", text: delta };
    } else if (
      method === "item/commandExecution/outputDelta" &&
      entry.item.type === "commandExecution"
    ) {
      entry.item = { ...entry.item, output: (entry.item.output ?? "") + delta };
      update = { type: "output.append", text: delta };
    } else return;
    this.emit({ type: "item.updated", turnId: this.turnId, itemId: entry.item.itemId, update });
  }
  finish(result: TurnOutcome): HostItemSnapshot[] {
    if (this.#closed) return [];
    this.#closed = true;
    const snapshots: HostItemSnapshot[] = [];
    for (const entry of this.#items.values()) {
      if (entry.done) continue;
      const snapshot = { item: entry.item, outcome: result };
      snapshots.push(snapshot);
      this.emit({ type: "item.completed", turnId: this.turnId, snapshot });
      entry.done = true;
    }
    return snapshots;
  }
}
