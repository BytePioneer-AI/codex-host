import type {
  HostItemSnapshot,
  HostSubagentState,
  HostThreadSnapshot,
  HostToolExecutionItem,
} from "@codexhost/harness-adapter";

import { contentText, isRecord } from "../projection.js";
import {
  ModernJournalError,
  type ModernJournalEvent,
  type ModernJournalHeader,
} from "./journal.js";
import { modernItemId } from "./history.js";

export type ModernSubagentPath = readonly {
  readonly childSessionId: string;
  readonly mode: "one-shot" | "continuable";
}[];

const PREFIX = "dsh-subagent-v1:";
export const MODERN_SUBAGENT_MAX_DEPTH = 16;
export const MODERN_SUBAGENT_MAX_CHILDREN = 256;

export function encodeModernSubagentId(rootSessionId: string, path: ModernSubagentPath): string {
  const value =
    PREFIX +
    Buffer.from(
      JSON.stringify([
        rootSessionId,
        ...path.map((entry) => [entry.childSessionId, entry.mode === "one-shot" ? 0 : 1]),
      ]),
    ).toString("base64url");
  if (value.length > 1024 || path.length > MODERN_SUBAGENT_MAX_DEPTH)
    throw new ModernJournalError(
      "limitExceeded",
      "DeepSeek subagent identity exceeded the Host identity limit",
    );
  return value;
}

export function decodeModernSubagentId(value: string, rootSessionId: string): ModernSubagentPath {
  const invalid = () =>
    new ModernJournalError("protocolError", "Invalid DeepSeek subagent identity");
  if (value.length > 1024 || !value.startsWith(PREFIX)) throw invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value.slice(PREFIX.length), "base64url").toString());
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length < 2 ||
    decoded[0] !== rootSessionId ||
    decoded.length - 1 > MODERN_SUBAGENT_MAX_DEPTH
  )
    throw invalid();
  const ids = new Set([rootSessionId]);
  const path: { childSessionId: string; mode: "one-shot" | "continuable" }[] = [];
  for (const entry of decoded.slice(1)) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !entry[0] ||
      entry[0].length > 512 ||
      (entry[1] !== 0 && entry[1] !== 1) ||
      ids.has(entry[0])
    )
      throw invalid();
    ids.add(entry[0]);
    path.push({ childSessionId: entry[0], mode: entry[1] === 0 ? "one-shot" : "continuable" });
  }
  if (encodeModernSubagentId(rootSessionId, path) !== value) throw invalid();
  return path;
}

export interface ModernSubagentEntry {
  id: string;
  mode: "one-shot" | "continuable";
  label?: string;
  activity: "running" | "inactive";
  hasChildren: boolean;
}

export function parseModernSubagentCatalog(value: unknown): ModernSubagentEntry[] {
  const invalid = () =>
    new ModernJournalError("protocolError", "Invalid DeepSeek subagent catalog");
  if (
    !isRecord(value) ||
    typeof value.parentAvailable !== "boolean" ||
    !Array.isArray(value.entries)
  )
    throw invalid();
  if (value.entries.length > MODERN_SUBAGENT_MAX_CHILDREN)
    throw new ModernJournalError(
      "limitExceeded",
      "DeepSeek subagent catalog exceeded its child limit",
    );
  const entries: ModernSubagentEntry[] = [];
  const ids = new Set<string>();
  for (const row of value.entries) {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 512 ||
      ids.has(row.id)
    )
      throw invalid();
    ids.add(row.id);
    if (row.kind === "diagnostic") {
      if (!["corrupt", "unsupported", "unavailable"].includes(String(row.reason))) throw invalid();
      continue;
    }
    if (
      row.kind !== "child" ||
      !["one-shot", "continuable"].includes(String(row.mode)) ||
      !["running", "inactive"].includes(String(row.activity)) ||
      typeof row.hasChildren !== "boolean" ||
      (row.label !== undefined && typeof row.label !== "string") ||
      (row.mode === "continuable" && typeof row.label !== "string")
    )
      throw invalid();
    entries.push({
      id: row.id,
      mode: row.mode as ModernSubagentEntry["mode"],
      activity: row.activity as ModernSubagentEntry["activity"],
      hasChildren: row.hasChildren,
      ...(typeof row.label === "string" ? { label: row.label } : {}),
    });
  }
  return entries;
}

export interface ModernSubagentFacts {
  entry: ModernSubagentEntry;
  path: ModernSubagentPath;
  header: ModernJournalHeader;
  events: readonly ModernJournalEvent[];
  inheritedEventCount: number;
  snapshot: HostThreadSnapshot;
  state: HostSubagentState & { nativeSubagentId: string };
}

/** A balanced no-op Turn cannot erase failed work or input cancelled before it ran. */
function consumedReason(events: readonly ModernJournalEvent[]): {
  reason?: Record<string, unknown>;
  dropped: boolean;
} {
  let stepped = false;
  let claimed = false;
  let open = false;
  let dropped = false;
  let reason: Record<string, unknown> | undefined;
  for (const event of events) {
    if (!isRecord(event.data)) continue;
    if (event.type === "turn/start") {
      stepped = false;
      claimed = false;
      open = true;
    }
    if (event.type === "step/start") stepped = true;
    if (event.type === "agent/inbox/spliced" && event.data.removedCount !== undefined) {
      if (event.data.outcome === "canceled")
        dropped ||= Array.isArray(event.data.inserted) && event.data.inserted.length === 0;
      else if (open) claimed = true;
    }
    if (event.type === "turn/end" && isRecord(event.data.reason)) {
      open = false;
      if (stepped || (claimed && event.data.reason.kind !== "completed")) {
        reason = event.data.reason;
        dropped = false;
      }
    }
  }
  return { ...(reason ? { reason } : {}), dropped };
}

export function modernSubagentState(
  root: string,
  facts: Omit<ModernSubagentFacts, "state">,
): HostSubagentState & { nativeSubagentId: string } {
  const own = facts.events.slice(facts.inheritedEventCount);
  const descriptor = own.findLast((event) => event.type === "subagent/descriptor")?.data;
  const edge = own.findLast((event) => event.type === "turn/start" || event.type === "turn/end");
  const terminal =
    edge?.type === "turn/end" && isRecord(edge.data) && isRecord(edge.data.reason)
      ? edge.data.reason
      : undefined;
  const consumed = consumedReason(own);
  const reason = consumed.reason ?? terminal;
  const incomplete = facts.entry.activity === "inactive" && edge?.type === "turn/start";
  const status =
    facts.entry.activity === "running"
      ? "running"
      : incomplete
        ? "interrupted"
        : reason?.kind === "completed" || (!reason && consumed.dropped)
          ? consumed.dropped
            ? "interrupted"
            : "completed"
          : reason?.kind === "aborted" || reason?.kind === "interrupted"
            ? "interrupted"
            : reason
              ? "failed"
              : "pending";
  const lastTurn = edge ? facts.snapshot.turns.at(-1) : undefined;
  const lastMessage = lastTurn?.items.findLast(({ item }) => item.type === "agentMessage")?.item;
  const summary = incomplete
    ? "DeepSeek 子会话当前未运行，但历史缺少本轮终态；执行结果未知。"
    : lastMessage?.type === "agentMessage"
      ? lastMessage.text.slice(0, 2000)
      : undefined;
  return {
    subagentId: encodeModernSubagentId(root, facts.path),
    nativeSubagentId: encodeModernSubagentId(root, facts.path),
    description: (facts.entry.label ?? "DeepSeek 子智能体").slice(0, 500),
    ...(isRecord(descriptor) && typeof descriptor.agentModel === "string"
      ? { model: descriptor.agentModel.slice(0, 500) }
      : {}),
    ...(isRecord(descriptor) && typeof descriptor.agentReasoningEffort === "string"
      ? { reasoningEffort: descriptor.agentReasoningEffort.slice(0, 100) }
      : {}),
    background: facts.entry.mode === "continuable",
    status,
    ...(summary ? { resultSummary: summary } : {}),
  };
}

export function isModernSubagentTool(item: HostToolExecutionItem): boolean {
  return (
    item.toolName === "subagent" ||
    item.toolName === "subagent_fork" ||
    item.toolName === "send_message"
  );
}

function creationTurn(
  events: readonly ModernJournalEvent[],
  inheritedEventCount: number,
  createdAt: number,
): number | undefined {
  let turn: number | undefined;
  for (const event of events) {
    if (event.seq < inheritedEventCount || !isRecord(event.data)) continue;
    if (event.time > createdAt) break;
    if (event.type === "turn/start") turn = event.data.turn as number;
    if (event.type === "turn/end" && event.time < createdAt) turn = undefined;
  }
  return turn;
}

export function projectModernSubagents(input: {
  snapshot: HostThreadSnapshot;
  parentId: string;
  events: readonly ModernJournalEvent[];
  inheritedEventCount: number;
  children: readonly ModernSubagentFacts[];
  independentChildren?: ReadonlySet<string>;
}): HostThreadSnapshot {
  const assigned = new Set<string>();
  const turns = input.snapshot.turns.map((turn) => {
    const current = input.children.filter(
      (child) =>
        creationTurn(input.events, input.inheritedEventCount, child.header.createdAt) ===
        Number(turn.nativeTurnRef.nativeTurnKey.replace(/^turn:/u, "")),
    );
    const items = turn.items.map((snapshot): HostItemSnapshot => {
      const item = snapshot.item;
      if (item.type !== "toolExecution" || !isModernSubagentTool(item) || !isRecord(item.arguments))
        return snapshot;
      const args = item.arguments;
      const send = item.toolName === "send_message";
      const receipt = /^started subagent ([^\s]+)$/u.exec(contentText(item.output))?.[1];
      const candidates = (send ? input.children : current).filter((child) => {
        if (send) return child.entry.id === args.agent_id;
        if (input.independentChildren?.has(child.state.nativeSubagentId)) return false;
        if (receipt) return child.entry.id === receipt;
        const prompt = child.events
          .slice(child.inheritedEventCount)
          .find(
            (event) =>
              event.type === "user/message" &&
              isRecord(event.data) &&
              isRecord(event.data.source) &&
              event.data.source.kind === "user",
          );
        const blocks =
          prompt && isRecord(prompt.data) && Array.isArray(prompt.data.content)
            ? prompt.data.content
            : [];
        return (
          args.description === child.entry.label &&
          typeof args.prompt === "string" &&
          isRecord(blocks[0]) &&
          blocks[0].type === "text" &&
          blocks[0].text === args.prompt
        );
      });
      const child = candidates[0];
      if (!child || candidates.length !== 1) return snapshot;
      if (!send && !receipt) {
        const similar = turn.items.filter(
          (other) =>
            other.item.type === "toolExecution" &&
            ["subagent", "subagent_fork"].includes(other.item.toolName) &&
            isRecord(other.item.arguments) &&
            other.item.arguments.description === args.description &&
            other.item.arguments.prompt === args.prompt,
        );
        if (similar.length !== 1) return snapshot;
      }
      assigned.add(child.entry.id);
      const prompt = send ? item.arguments.message : item.arguments.prompt;
      return {
        ...snapshot,
        item: {
          type: "subagentDelegation",
          itemId: item.itemId,
          operation: send ? "send" : "spawn",
          ...(typeof prompt === "string" ? { prompt: prompt.slice(0, 128_000) } : {}),
          subagents: [
            {
              ...child.state,
              background:
                typeof item.arguments.run_in_background === "boolean"
                  ? item.arguments.run_in_background
                  : child.state.background,
            },
          ],
        },
      };
    });
    for (const child of current) {
      if (assigned.has(child.entry.id)) continue;
      items.push({
        item: {
          type: "subagentDelegation",
          itemId: modernItemId(input.parentId, `subagent:${child.entry.id}`),
          operation: "spawn",
          subagents: [child.state],
        },
        outcome: { status: "succeeded" },
      });
      assigned.add(child.entry.id);
    }
    return { ...turn, items };
  });
  return { ...input.snapshot, turns };
}
