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

/** Read Desktop's persisted projects, never infer them from execution cwd or write its file. */
export async function readNativeWorkspaceSnapshot(
  environment: NodeJS.ProcessEnv,
  nativeProjects?: ClientWorkspaceSnapshot["projects"],
): Promise<ClientWorkspaceSnapshot> {
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
  const sectionProjects = Object.fromEntries(
    Object.entries(desktopSectionProjects(state)).map(([sectionId, projects]) => [
      sectionId,
      projects.flatMap((id) => projectId(id) ?? []),
    ]),
  );
  return clientWorkspaceSnapshotSchema.parse({
    projects: nativeProjects ?? desktopProjectDefinitions(state, scope),
    ...(nativeProjects ? { nativeProjects: true } : {}),
    assignments: Object.fromEntries(
      Object.entries(assigned).flatMap(([id, value]) => {
        if (!value || typeof value !== "object") return [];
        const entry = value as Record<string, unknown>;
        const project = projectId(entry.projectId);
        return entry.projectKind === "local" && project ? [[id, project]] : [];
      }),
    ),
    projectless: state["projectless-thread-ids"] ?? [],
    pinned: [],
    ...(Object.keys(sectionProjects).length > 0 ? { sectionProjects } : {}),
  });
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

/** Combine requested native GUI facts with this owner's canonical no-project records. */
export async function readExternalWorkspaceSnapshot(
  environment: NodeJS.ProcessEnv,
  threads: readonly StoredThreadRecordV1[],
  placements: readonly StoredSectionPlacementV1[],
  nativeThreadIds: readonly string[] = [],
  nativeProjects?: ClientWorkspaceSnapshot["projects"],
): Promise<ClientWorkspaceSnapshot> {
  const snapshot = await readNativeWorkspaceSnapshot(environment, nativeProjects);
  const owned = new Set([
    ...threads.map((thread) => String(thread.hostThreadId)),
    ...nativeThreadIds,
  ]);
  const assignments = Object.fromEntries(
    Object.entries(snapshot.assignments).filter(([id]) => nativeProjects || owned.has(id)),
  );
  const projectless = new Set(
    snapshot.projectless.filter((id) => owned.has(id) && !assignments[id]),
  );
  const nativeIds = new Set(nativeProjects?.map((project) => project.id));
  for (const thread of threads) {
    if (thread.projectId && (!nativeProjects || nativeIds.has(thread.projectId))) {
      assignments[thread.hostThreadId] = thread.projectId;
      projectless.delete(thread.hostThreadId);
    } else if (thread.projectlessWorkspace && !assignments[thread.hostThreadId]) {
      projectless.add(thread.hostThreadId);
    }
  }
  return {
    ...snapshot,
    assignments,
    projectless: [...projectless],
    pinned: externalPinIds(threads, placements),
  };
}
