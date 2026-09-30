import type { HarnessDisplayEntries } from "@codexhost/shared-contracts";
import { KNOWN_RENDERER_AGENTS, type ExternalRendererAgent } from "./agent-selection-state.js";

/** Display-only grouping; never affects installation or availability. */
export type AgentGroupSection = "main" | "more";
export interface AgentGroupEntry {
  readonly agent: ExternalRendererAgent;
  readonly section: AgentGroupSection;
}
export type AgentGroupSyncStatus = "loading" | "ready" | "saving" | "error";
export interface AgentGroupPreferenceStore {
  list(notInstalled?: ReadonlySet<ExternalRendererAgent>): readonly AgentGroupEntry[];
  sectionOf(agent: ExternalRendererAgent, notInstalled?: boolean): AgentGroupSection;
  moveAgent(
    agent: ExternalRendererAgent,
    section: AgentGroupSection,
    beforeAgent?: ExternalRendererAgent | null,
  ): void;
  resetToDefault(): void;
  subscribe(listener: () => void): () => void;
  legacyEntries(): HarnessDisplayEntries;
  replace(entries: HarnessDisplayEntries): void;
  syncStatus(): AgentGroupSyncStatus;
  setSyncStatus(status: AgentGroupSyncStatus): void;
  setWriter(writer: ((entries: HarnessDisplayEntries) => void) | null): void;
}
export const AGENT_GROUP_PREFERENCE_STORAGE_KEY = "codexhost.agentGroupPreference.v1";
const EXTERNAL_AGENTS = KNOWN_RENDERER_AGENTS.filter(
  (agent): agent is ExternalRendererAgent => agent !== "codex",
);
function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Host-confirmed state stays in memory; localStorage is read only for migration. */
export function createAgentGroupPreferenceStore(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): AgentGroupPreferenceStore {
  let entries: HarnessDisplayEntries = [];
  const normalize = (input: HarnessDisplayEntries): HarnessDisplayEntries => {
    const seen = new Set<string>();
    const result = input.filter((entry) => {
      if (seen.has(entry.agent)) return false;
      seen.add(entry.agent);
      return true;
    });
    for (const agent of EXTERNAL_AGENTS) {
      if (!seen.has(agent)) result.push({ agent, section: "auto" });
    }
    return result;
  };
  const legacyEntries = (): HarnessDisplayEntries => {
    try {
      const value: unknown = JSON.parse(
        storage?.getItem(AGENT_GROUP_PREFERENCE_STORAGE_KEY) ?? "null",
      );
      if (Array.isArray(value)) {
        return normalize(
          value.filter(
            (entry): entry is HarnessDisplayEntries[number] =>
              entry &&
              typeof entry.agent === "string" &&
              ["main", "more", "auto"].includes(entry.section),
          ),
        );
      }
    } catch {
      /* Missing or inaccessible legacy data uses the default order. */
    }
    return normalize([]);
  };
  entries = normalize([]);
  let status: AgentGroupSyncStatus = "loading";
  let writer: ((entries: HarnessDisplayEntries) => void) | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const replace = (input: HarnessDisplayEntries): void => {
    const next = normalize(input);
    if (JSON.stringify(next) === JSON.stringify(entries)) return;
    entries = next;
    notify();
  };
  const commit = (next: HarnessDisplayEntries): void => {
    if (status !== "ready" && status !== "error") return;
    writer?.(next);
  };
  return {
    legacyEntries,
    replace,
    syncStatus: () => status,
    setSyncStatus(next) {
      if (status !== next) {
        status = next;
        notify();
      }
    },
    setWriter(next) {
      writer = next;
    },
    list(notInstalled) {
      return entries
        .filter((entry) => (EXTERNAL_AGENTS as readonly string[]).includes(entry.agent))
        .map((entry) => ({
          agent: entry.agent as ExternalRendererAgent,
          section:
            entry.section === "auto"
              ? notInstalled?.has(entry.agent as ExternalRendererAgent)
                ? "more"
                : "main"
              : entry.section,
        }));
    },
    sectionOf(agent, notInstalled = false) {
      const section = entries.find((entry) => entry.agent === agent)?.section;
      return section && section !== "auto" ? section : notInstalled ? "more" : "main";
    },
    moveAgent(agent, section, beforeAgent = null) {
      if (!EXTERNAL_AGENTS.includes(agent)) return;
      const next = entries.filter((entry) => entry.agent !== agent);
      const index =
        beforeAgent && beforeAgent !== agent
          ? next.findIndex((entry) => entry.agent === beforeAgent)
          : -1;
      const moved = { agent, section };
      if (index >= 0) next.splice(index, 0, moved);
      else next.push(moved);
      commit(next);
    },
    resetToDefault() {
      commit([]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
let sharedStore: AgentGroupPreferenceStore | null = null;
export function getSharedAgentGroupPreferenceStore(): AgentGroupPreferenceStore {
  if (!sharedStore) sharedStore = createAgentGroupPreferenceStore();
  return sharedStore;
}
