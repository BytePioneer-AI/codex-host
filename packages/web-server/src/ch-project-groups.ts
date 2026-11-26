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
 * The folder an unassigned Thread is listed under once folders opened in Web are considered.
 * A project root that merely contains such a folder does not take its Threads: the user opened
 * the folder as its own Workspace, which is more specific than the project around it.
 * @param root Project group root already chosen for the Thread's cwd.
 * @param cwd Actual execution directory.
 * @param webWorkspaces Folders the user opened as Workspaces in Web.
 * @returns The deepest such folder holding the cwd below the project root, else the root.
 */
export function webWorkspaceGroupRoot(
  root: string,
  cwd: string,
  webWorkspaces: readonly string[],
): string {
  const holds = (folder: string, path: string) => {
    const inner = relative(folder, path);
    return inner !== "" && !isAbsolute(inner) && inner !== ".." && !inner.startsWith(".." + sep);
  };
  const target = resolve(cwd);
  const nested = webWorkspaces
    .map((path) => resolve(path))
    .filter((path) => holds(resolve(root), path) && (path === target || holds(path, target)));
  return nested.sort((a, b) => b.length - a.length)[0] ?? root;
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
