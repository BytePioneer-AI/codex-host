import path from "node:path";
import { homedir } from "node:os";
import { readDesktopGlobalState } from "@codexhost/desktop-control";
import type { StoredSectionPlacementV1, StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  clientWorkspaceSnapshotSchema,
  desktopProjectDefinitions,
  type ClientWorkspaceSnapshot,
} from "@codexhost/shared-contracts";

import { externalPinIds } from "./external-thread-pins.js";

interface WorkspaceProjects {
  snapshot: ClientWorkspaceSnapshot;
  legacyAssignedThreads: ReadonlySet<string>;
  nativeByGui: Map<string, string>;
  guiByNative: Map<string, string>;
}

export async function readNativeWorkspaceSnapshot(
  environment: NodeJS.ProcessEnv,
  nativeProjects?: ClientWorkspaceSnapshot["projects"],
): Promise<ClientWorkspaceSnapshot> {
  return (await readWorkspaceProjects(environment, nativeProjects)).snapshot;
}

function localProjectIds(state: Record<string, unknown>, scope: string) {
  const mappings = state["app-server-project-id-by-legacy-project-id-by-host"];
  if (mappings === undefined) return {};
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return null;
  const scoped = (mappings as Record<string, unknown>)[scope];
  if (scoped === undefined) return {};
  return scoped && typeof scoped === "object" && !Array.isArray(scoped)
    ? (scoped as Record<string, unknown>)
    : null;
}

function workspaceProjects(
  snapshot: ClientWorkspaceSnapshot,
  mappings: Record<string, unknown> | null = {},
  legacyAssignedThreads: ReadonlySet<string> = new Set(),
): WorkspaceProjects {
  const nativeByGui = new Map<string, string>();
  const guiByNative = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { id } of snapshot.projects) {
    if (!mappings || !id.trim() || id.length > 1024) continue;
    const nativeId = Object.hasOwn(mappings, id) ? mappings[id] : id;
    if (typeof nativeId !== "string" || !nativeId.trim()) continue;
    if (guiByNative.has(nativeId)) ambiguous.add(nativeId);
    nativeByGui.set(id, nativeId);
    guiByNative.set(nativeId, id);
  }
  for (const id of ambiguous) guiByNative.delete(id);
  for (const [guiId, nativeId] of nativeByGui)
    if (!guiByNative.has(nativeId)) nativeByGui.delete(guiId);
  return { snapshot, legacyAssignedThreads, nativeByGui, guiByNative };
}

/** Read Desktop's persisted projects, never infer them from execution cwd or write its file. */
export async function readWorkspaceProjects(
  environment: NodeJS.ProcessEnv,
  nativeProjects?: ClientWorkspaceSnapshot["projects"],
): Promise<WorkspaceProjects> {
  const codexHome = environment.CODEX_HOME ?? path.join(homedir(), ".codex");
  const parsed = await readDesktopGlobalState(codexHome);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid native workspace metadata");
  const state = parsed as Record<string, unknown>;
  const order = state["project-order"] ?? [];
  const local = state["local-projects"] ?? {};
  const assigned = state["thread-project-assignments"] ?? {};
  if (
    !Array.isArray(order) ||
    !order.every((id) => typeof id === "string") ||
    !local ||
    typeof local !== "object" ||
    Array.isArray(local) ||
    !assigned ||
    typeof assigned !== "object" ||
    Array.isArray(assigned)
  )
    throw new Error("Invalid native project metadata");
  const scope = `local:${path.resolve(codexHome)}`;
  const ids = new Set(nativeProjects?.map((project) => project.id));
  const migration = state["app-server-project-id-by-legacy-project-id-by-host"];
  const aliases =
    migration && typeof migration === "object"
      ? (migration as Record<string, Record<string, unknown>>)[scope]
      : undefined;
  const projectId = (id: unknown): string | undefined => {
    if (typeof id !== "string") return undefined;
    if (!nativeProjects || ids.has(id)) return id;
    const mapped = aliases?.[id];
    return typeof mapped === "string" && ids.has(mapped) ? mapped : undefined;
  };
  const legacyAssignedThreads = new Set<string>();
  const sectionProjects = Object.fromEntries(
    Object.entries(desktopSectionProjects(state)).flatMap(([sectionId, projects]) => {
      const resolved = projects.flatMap((id) => projectId(id) ?? []);
      return resolved.length === projects.length ? [[sectionId, resolved]] : [];
    }),
  );
  const rawPinnedProjects = state["pinned-project-ids"];
  const pinnedProjects = Array.isArray(rawPinnedProjects)
    ? [
        ...new Set(
          rawPinnedProjects.flatMap((id) => {
            if (typeof id !== "string" || id === "") return [];
            const resolved = projectId(id);
            return resolved ? [resolved] : [];
          }),
        ),
      ]
    : undefined;
  const snapshot = clientWorkspaceSnapshotSchema.parse({
    projects: nativeProjects ?? desktopProjectDefinitions(state, scope),
    ...(nativeProjects ? { nativeProjects: true } : {}),
    assignments: Object.fromEntries(
      Object.entries(assigned).flatMap(([id, value]) => {
        if (!value || typeof value !== "object") return [];
        const entry = value as Record<string, unknown>;
        if (entry.projectKind !== "local" || typeof entry.projectId !== "string") return [];
        legacyAssignedThreads.add(id);
        const project = projectId(entry.projectId);
        return project !== undefined ? [[id, project]] : [];
      }),
    ),
    projectless: state["projectless-thread-ids"] ?? [],
    pinned: [],
    ...(Object.keys(sectionProjects).length > 0 ? { sectionProjects } : {}),
    ...(pinnedProjects !== undefined ? { pinnedProjects } : {}),
  });
  return workspaceProjects(
    snapshot,
    nativeProjects ? {} : localProjectIds(state, scope),
    legacyAssignedThreads,
  );
}

const PROJECT_ITEM_PREFIX = "codex:project:";

/**
 * Projects in each Desktop custom section, keyed by the section's official ID.
 *
 * The official app-server stores section definitions and Thread members only. Desktop keeps
 * project members in the signed-in owner's renderer atom `sidebar-custom-sections-v3`, one
 * entry per account, and links each logical section to its official section through
 * `hostSectionIds.local`. That atom is private and versioned, so a missing or reshaped atom
 * yields no project sections instead of failing the project snapshot. A known section with
 * no local project members has an explicit empty list.
 */
function desktopSectionProjects(state: Record<string, unknown>): Record<string, string[]> {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const owner = state["electron-renderer-content-owner"];
  const atoms = typeof owner === "string" ? state[`electron-owner-atoms:${owner}`] : undefined;
  const accounts = record(atoms) ? atoms["sidebar-custom-sections-v3"] : undefined;
  const sections: Record<string, string[]> = Object.create(null);
  if (!record(accounts)) return sections;
  for (const account of Object.values(accounts)) {
    if (!record(account) || !Array.isArray(account.sections)) continue;
    for (const section of account.sections) {
      if (!record(section) || !record(section.hostSectionIds) || !Array.isArray(section.itemKeys))
        continue;
      const id = section.hostSectionIds.local;
      // Prefer the first nonempty project list when accounts repeat an official section.
      if (typeof id !== "string" || id === "" || sections[id]?.length) continue;
      const projects = section.itemKeys.flatMap((key) =>
        typeof key === "string" &&
        key.startsWith(PROJECT_ITEM_PREFIX) &&
        key.length > PROJECT_ITEM_PREFIX.length
          ? [key.slice(PROJECT_ITEM_PREFIX.length)]
          : [],
      );
      if (
        projects.length > 0 ||
        section.itemKeys.every(
          (key) => typeof key === "string" && key !== "" && key !== PROJECT_ITEM_PREFIX,
        )
      )
        sections[id] = projects;
    }
  }
  return sections;
}

/** Project authoritative assignments into the same ID space as the GUI definitions. */
export async function readExternalWorkspaceSnapshot(
  environment: NodeJS.ProcessEnv,
  threads: readonly StoredThreadRecordV1[],
  placements: readonly StoredSectionPlacementV1[],
  nativeThreadIds: readonly string[] = [],
  nativeProjects?: ClientWorkspaceSnapshot["projects"],
  readProjectIds?: (
    threadIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string | null | undefined>>,
  canMove = false,
): Promise<ClientWorkspaceSnapshot> {
  const { snapshot, legacyAssignedThreads, nativeByGui, guiByNative } = await readWorkspaceProjects(
    environment,
    nativeProjects,
  );
  const externalIds = new Set(threads.map((thread) => String(thread.hostThreadId)));
  const owned = new Set([...externalIds, ...nativeThreadIds]);
  const assignments = new Map(
    Object.entries(snapshot.assignments).filter(([id]) => nativeProjects || owned.has(id)),
  );
  const verified = canMove ? new Map<string, string | null>() : undefined;
  const projectless = new Set(
    snapshot.projectless.filter((id) => owned.has(id) && !assignments.has(id)),
  );
  if (readProjectIds) {
    const official = [...owned].filter((id) => !externalIds.has(id));
    const values = await readProjectIds(official);
    for (const id of official) {
      const nativeId = values.get(id);
      // Only a successful legacy read may retain the GUI assignment for navigation.
      if (nativeId === undefined && values.has(id)) continue;
      const guiId = typeof nativeId === "string" ? guiByNative.get(nativeId) : undefined;
      if (guiId === undefined) assignments.delete(id);
      else assignments.set(id, guiId);
      if (guiId !== undefined || nativeId === null) verified?.set(id, guiId ?? null);
      if (nativeId === null) projectless.add(id);
      else if (guiId !== undefined) projectless.delete(id);
    }
  }
  for (const thread of threads) {
    if (thread.projectId === "") {
      assignments.delete(thread.hostThreadId);
      verified?.set(thread.hostThreadId, null);
      projectless.add(thread.hostThreadId);
    } else if (thread.projectId !== undefined) {
      const guiId = guiByNative.get(thread.projectId);
      if (guiId !== undefined) {
        assignments.set(thread.hostThreadId, guiId);
        verified?.set(thread.hostThreadId, guiId);
      } else assignments.delete(thread.hostThreadId);
      projectless.delete(thread.hostThreadId);
    } else {
      // An inherited Desktop assignment is navigation-only, not proof of no project.
      if (!legacyAssignedThreads.has(thread.hostThreadId)) verified?.set(thread.hostThreadId, null);
      if (assignments.has(thread.hostThreadId)) continue;
      if (thread.projectlessWorkspace) projectless.add(thread.hostThreadId);
    }
  }
  return {
    ...snapshot,
    assignments: Object.fromEntries(assignments),
    ...(verified
      ? {
          projectMoveBindings: {
            projectIds: [...nativeByGui.keys()],
            assignments: Object.fromEntries(verified),
          },
        }
      : {}),
    projectless: [...projectless],
    pinned: externalPinIds(threads, placements),
  };
}
