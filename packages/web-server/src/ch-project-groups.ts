/** A native execution cwd is not proof that the user selected a project. */
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { ChProjectSnapshot } from "./ch-host-client.ts";

function containsPath(root: string, cwd: string): boolean {
  const path = relative(root, cwd);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
}

/** First folder of a GUI project. Every folder in that project shares this navigation path. */
export function projectNavigationRoot(rootPaths: readonly string[]): string | undefined {
  const root = rootPaths.find((item) => item !== "");
  return root === undefined ? undefined : resolve(root);
}

/** Return the selected GUI project's navigation root, never change execution cwd.
 * @param snapshot Current native local projects and projectless classification.
 * @param threadId Canonical CH Thread ID.
 * @param cwd Actual execution directory.
 * @returns The project's first root, or undefined for unselected/generated directories.
 */
export function projectGroupRoot(
  snapshot: ChProjectSnapshot,
  threadId: string,
  cwd: string,
): string | undefined {
  const assigned = snapshot.assignments[threadId];
  const project = snapshot.projects.find((item) => item.id === assigned);
  if (!project && snapshot.projectless.includes(threadId)) return undefined;
  const resolvedCwd = resolve(cwd);
  let selected: { project: ChProjectSnapshot["projects"][number]; length: number } | undefined;
  for (const candidate of project ? [project] : snapshot.projects) {
    for (const rootPath of candidate.rootPaths) {
      const root = resolve(rootPath);
      if (!containsPath(root, resolvedCwd)) continue;
      if (!selected || root.length > selected.length)
        selected = { project: candidate, length: root.length };
    }
  }
  const owner = selected?.project ?? project;
  return owner ? projectNavigationRoot(owner.rootPaths) : undefined;
}
