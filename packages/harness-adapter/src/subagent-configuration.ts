import type { HostEvent, HostSubagentState, HostThreadSnapshot } from "./text-session.js";

export type SubagentConfiguration = Pick<HostSubagentState, "model" | "reasoningEffort">;

/** Read optional native tool configuration without coercing objects or display labels. */
export function subagentConfiguration(value: unknown): SubagentConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;
  const model = row.model === "inherit" ? undefined : text(row.model);
  const reasoningEffort =
    text(row.reasoningEffort) ?? text(row.reasoning_effort) ?? text(row.thinking);
  return { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** Native child values win. Missing values inherit the parent's selected configuration. */
export function inheritSubagentConfiguration(
  child: HostSubagentState,
  parent: SubagentConfiguration,
): HostSubagentState {
  const native = subagentConfiguration(child);
  const model = native.model ?? parent.model;
  const reasoningEffort = native.reasoningEffort ?? parent.reasoningEffort;
  const next = { ...child };
  delete next.model;
  delete next.reasoningEffort;
  return { ...next, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** Keep starts, replacements and completions consistent using the existing Host contract. */
export function configureSubagentEvent(event: HostEvent, parent: SubagentConfiguration): HostEvent {
  const children = (states: HostSubagentState[]) =>
    states.map((child) => inheritSubagentConfiguration(child, parent));
  if (event.type === "item.started" && event.item.type === "subagentDelegation")
    return { ...event, item: { ...event.item, subagents: children(event.item.subagents) } };
  if (event.type === "item.updated" && event.update.type === "subagents.replace")
    return { ...event, update: { ...event.update, subagents: children(event.update.subagents) } };
  if (event.type === "item.completed" && event.snapshot.item.type === "subagentDelegation")
    return {
      ...event,
      snapshot: {
        ...event.snapshot,
        item: {
          ...event.snapshot.item,
          subagents: children(event.snapshot.item.subagents),
        },
      },
    };
  return event;
}

export function configureSubagentSnapshot(
  snapshot: HostThreadSnapshot,
  parent: SubagentConfiguration,
): HostThreadSnapshot {
  return {
    ...snapshot,
    turns: snapshot.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((entry) =>
        entry.item.type === "subagentDelegation"
          ? {
              ...entry,
              item: {
                ...entry.item,
                subagents: entry.item.subagents.map((child) =>
                  inheritSubagentConfiguration(child, parent),
                ),
              },
            }
          : entry,
      ),
    })),
  };
}
