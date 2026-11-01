import type { HarnessDisplayEntries } from "@codexhost/shared-contracts";
import type { ExternalRendererAgent, RendererAgent } from "./agent-selection-state.js";

/** Display-only grouping; never affects installation or availability. */
export type AgentGroupSection = "main" | "more";
export interface AgentGroupEntry {
  readonly agent: ExternalRendererAgent;
  readonly section: AgentGroupSection;
}
export type AgentGroupSyncStatus = "loading" | "ready" | "saving" | "error";
type AgentDisplayCatalog = readonly { readonly id: RendererAgent; readonly name: string }[];
export interface AgentGroupPreferenceStore {
  list(
    notInstalled?: ReadonlySet<ExternalRendererAgent>,
    catalog?: AgentDisplayCatalog,
  ): readonly AgentGroupEntry[];
  sectionOf(agent: ExternalRendererAgent, notInstalled?: boolean): AgentGroupSection;
  moveAgent(
    agent: ExternalRendererAgent,
    section: AgentGroupSection,
    beforeAgent?: ExternalRendererAgent | null,
    catalog?: AgentDisplayCatalog,
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

// Display preference only: this list never registers or synthesizes plugins.
const DEFAULT_AGENT_ORDER = [
  "pi",
  "claude-code",
  "deepseek-harness",
  "opencode",
  "grok",
  "omp",
  "antigravity",
  "kiro-cli",
  "codebuddy",
  "workbuddy",
  "cursor-cli",
  "hermes",
  "qoder",
  "qoder-cn",
  "kimi-code",
  "zcode",
];
const defaultRank = new Map(DEFAULT_AGENT_ORDER.map((id, index) => [id, index]));
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
    return result;
  };
  const withDefaults = (catalog: AgentDisplayCatalog = []): HarnessDisplayEntries => {
    const recorded = new Set(entries.map(({ agent }) => agent));
    const missing = catalog
      .filter(({ id }) => id !== "codex" && !recorded.has(id))
      .slice()
      .sort((left, right) => {
        const rank =
          (defaultRank.get(left.id) ?? Infinity) - (defaultRank.get(right.id) ?? Infinity);
        return rank || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
      });
    return normalize([
      ...entries,
      ...missing.map(({ id }) => ({ agent: id, section: "auto" as const })),
    ]);
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
    list(notInstalled, catalog) {
      const available = catalog && new Set(catalog.map(({ id }) => id));
      return withDefaults(catalog)
        .filter((entry) => entry.agent !== "codex" && (!available || available.has(entry.agent)))
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
    moveAgent(agent, section, beforeAgent = null, catalog) {
      if (agent === "codex") return;
      const next = withDefaults(catalog).filter((entry) => entry.agent !== agent);
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
