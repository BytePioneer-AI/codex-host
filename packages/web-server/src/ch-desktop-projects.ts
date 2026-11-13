import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  desktopProjectDefinitions,
  type ClientWorkspaceSnapshot,
} from "@codexhost/shared-contracts";

/** Compatibility with an already-running Host that filters out migrated projects.
 * Only project definitions are supplemented; the Host still owns Thread membership. */
export async function completeDesktopProjects(
  snapshot: ClientWorkspaceSnapshot,
  codexHome: string,
): Promise<ClientWorkspaceSnapshot> {
  let state: Record<string, unknown>;
  try {
    const file = await open(join(codexHome, ".codex-global-state.json"), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return snapshot;
      const text = await file.readFile("utf8");
      if (Buffer.byteLength(text) > 32 * 1024 * 1024) return snapshot;
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return snapshot;
      state = parsed as Record<string, unknown>;
    } finally {
      await file.close();
    }
  } catch {
    return snapshot;
  }
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  for (const project of desktopProjectDefinitions(state, `local:${resolve(codexHome)}`))
    if (!projects.has(project.id)) projects.set(project.id, project);
  return { ...snapshot, projects: [...projects.values()] };
}
