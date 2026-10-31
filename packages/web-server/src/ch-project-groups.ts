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
  if (matches.length) return matches.sort((a, b) => b.length - a.length)[0];
  // An explicitly assigned worktree may live outside its parent project's root.
  return project?.rootPaths[0];
}
