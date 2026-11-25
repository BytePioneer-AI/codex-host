/** A native execution cwd is not proof that the user selected a project. */
import { resolve, relative, isAbsolute, sep } from "node:path";
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

/**
 * The native project an unassigned Thread belongs to, as Desktop groups it: the project with
 * the deepest root holding its cwd, unless the Thread was explicitly moved out of projects.
 * @param snapshot Current native projects and projectless classification.
 * @param threadId Canonical CH Thread ID without a project ID or assignment.
 * @param cwd Actual execution directory.
 * @returns Native project ID, or undefined when no project root holds the cwd.
 */
export function nativeProjectByCwd(
  snapshot: ChProjectSnapshot,
  threadId: string,
  cwd: string,
): string | undefined {
  const root = projectGroupRoot(snapshot, threadId, cwd);
  if (root === undefined) return undefined;
  return snapshot.projects.find((project) =>
    project.rootPaths.some((path) => resolve(path) === root),
  )?.id;
}
