/** A native execution cwd is not proof that the user selected a project. */
import { resolve, relative, isAbsolute, sep } from "node:path";
import { desktopProjectPathKey } from "@codexhost/shared-contracts";
import type { ChProjectSnapshot } from "./ch-host-client.ts";

/** Return the selected GUI project's root for navigation, never change execution cwd.
 * @param snapshot Current native local projects and projectless classification.
 * @param threadId Canonical CH Thread ID.
 * @param cwd Actual execution directory.
 * @returns Project group root, or undefined for unselected/generated directories.
 */
export function projectGroupRoot(
  snapshot: ChProjectSnapshot,
  threadId: string,
  cwd: string,
): string | undefined {
  const assigned = snapshot.assignments[threadId];
  const project = snapshot.projects.find((item) => item.id === assigned);
  const roots = project?.rootPaths ?? snapshot.projects.flatMap((item) => item.rootPaths);
  if (!project && snapshot.projectless.includes(threadId)) return undefined;
  const matches = roots
    .map((root) => resolve(root))
    .filter((root) => {
      const path = relative(root, resolve(cwd));
      return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
    });
  const match = matches.sort((a, b) => b.length - a.length)[0];
  if (match !== undefined) {
    // A folder is the Workspace of the earliest project whose first root it is. A Thread
    // assigned to a different project that also lists the folder stays with its own project,
    // as Desktop shows it.
    const owner = snapshot.projects.find(
      (item) => item.rootPaths[0] !== undefined && resolve(item.rootPaths[0]) === match,
    );
    if (!project || !owner || owner === project) return match;
  }
  // An explicitly assigned worktree may live outside its parent project's root.
  return project?.rootPaths[0];
}

/** Only a registered root can infer native project membership from an ordinary local cwd. */
export function nativeProjectRootOwners(projects: ChProjectSnapshot["projects"]) {
  const owners = new Map<
    string,
    { path: string; projectId: string; priority: number; createdAt: number | undefined }
  >();
  for (const project of projects) {
    for (const [index, path] of project.rootPaths.entries()) {
      const key = desktopProjectPathKey(path);
      // A dedicated project owns a shared root before a multi-root project, then its primary root.
      const priority = project.rootPaths.length === 1 ? 2 : index === 0 ? 1 : 0;
      const current = owners.get(key);
      if (current && priority === current.priority) {
        // Older Hosts omit creation time. Keep their original catalog order on equal priority.
        if (project.createdAt === undefined || current.createdAt === undefined) continue;
        if (project.createdAt > current.createdAt) continue;
        if (
          project.createdAt === current.createdAt &&
          project.id.localeCompare(current.projectId) <= 0
        )
          continue;
      } else if (current && priority < current.priority) continue;
      owners.set(key, { path, projectId: project.id, priority, createdAt: project.createdAt });
    }
  }
  return owners;
}
