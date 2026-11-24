import { open } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
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
): Promise<ClientWorkspaceSnapshot> {
  const codexHome = environment.CODEX_HOME ?? path.join(homedir(), ".codex");
  const file = path.join(codexHome, ".codex-global-state.json");
  let text: string;
  try {
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
        throw new Error("Invalid or oversized native workspace metadata");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { projects: [], assignments: {}, projectless: [], pinned: [] };
    throw error;
  }
  if (Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error("Native workspace metadata exceeds its read limit");
  const parsed: unknown = JSON.parse(text);
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
  const sectionProjects = desktopSectionProjects(state);
  return clientWorkspaceSnapshotSchema.parse({
    projects: desktopProjectDefinitions(state, `local:${path.resolve(codexHome)}`),
    assignments: Object.fromEntries(
      Object.entries(assigned).flatMap(([id, value]) => {
        if (!value || typeof value !== "object") return [];
        const entry = value as Record<string, unknown>;
        return entry.projectKind === "local" ? [[id, entry.projectId]] : [];
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
 * yields no project sections instead of failing the project snapshot.
 */
function desktopSectionProjects(state: Record<string, unknown>): Record<string, string[]> {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const owner = state["electron-renderer-content-owner"];
  const atoms = typeof owner === "string" ? state[`electron-owner-atoms:${owner}`] : undefined;
  const accounts = record(atoms) ? atoms["sidebar-custom-sections-v3"] : undefined;
  const sections: Record<string, string[]> = {};
  if (!record(accounts)) return sections;
  for (const account of Object.values(accounts)) {
    if (!record(account) || !Array.isArray(account.sections)) continue;
    for (const section of account.sections) {
      if (!record(section) || !record(section.hostSectionIds) || !Array.isArray(section.itemKeys))
        continue;
      const id = section.hostSectionIds.local;
      if (typeof id !== "string" || id === "" || Object.hasOwn(sections, id)) continue;
      const projects = section.itemKeys.flatMap((key) =>
        typeof key === "string" &&
        key.startsWith(PROJECT_ITEM_PREFIX) &&
        key.length > PROJECT_ITEM_PREFIX.length
          ? [key.slice(PROJECT_ITEM_PREFIX.length)]
          : [],
      );
      if (projects.length > 0) sections[id] = projects;
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
): Promise<ClientWorkspaceSnapshot> {
  const snapshot = await readNativeWorkspaceSnapshot(environment);
  const owned = new Set([
    ...threads.map((thread) => String(thread.hostThreadId)),
    ...nativeThreadIds,
  ]);
  const assignments = Object.fromEntries(
    Object.entries(snapshot.assignments).filter(([id]) => owned.has(id)),
  );
  const projectless = new Set(
    snapshot.projectless.filter((id) => owned.has(id) && !assignments[id]),
  );
  for (const thread of threads) {
    if (thread.projectId) {
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
