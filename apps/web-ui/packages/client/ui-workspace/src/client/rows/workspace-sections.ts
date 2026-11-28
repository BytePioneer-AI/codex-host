import type {
  WorkspaceId,
  WorkspaceThreadSection,
  WorkspaceView,
} from "@deepseek-ai/dsh-api-workspace-controller/types";
import { PINNED_SECTION_KEY } from "../stores.ts";
import { owningParentFolder, UNGROUPED_KEY } from "../tree.ts";

/**
 * Resolve sidebar section ownership for Workspaces.
 * `nativeSectionOf` preserves each Workspace's underlying native custom section so unpinning
 * returns it there; `sectionOf` overlays the Pinned section for currently pinned Workspaces.
 */
export function resolveWorkspaceSectionOwners(
  nativeSections: readonly Pick<WorkspaceThreadSection, "id" | "workspaceIds">[],
  pinnedWorkspaceIds: ReadonlySet<string>,
): {
  nativeSectionOf: Map<string, string>;
  sectionOf: Map<string, string>;
} {
  const nativeSectionOf = new Map<string, string>();
  for (const section of nativeSections) {
    for (const id of section.workspaceIds ?? []) {
      if (!nativeSectionOf.has(id)) nativeSectionOf.set(id, section.id);
    }
  }
  const sectionOf = new Map(nativeSectionOf);
  for (const id of pinnedWorkspaceIds) sectionOf.set(id, PINNED_SECTION_KEY);
  return { nativeSectionOf, sectionOf };
}

/**
 * Resolve nearest registered parent Workspace within each host and underlying native section
 * scope. Pinned Workspaces detach as top-level roots so they render in Pinned while their
 * unpinned descendants stay nested under them and move together.
 */
export function computeWorkspaceParents(
  workspaces: readonly Pick<WorkspaceView, "workspaceId" | "path" | "remote">[],
  nestWorkspaces: boolean,
  nativeSectionOf: ReadonlyMap<string, string>,
  pinnedWorkspaceIds: ReadonlySet<string>,
): Map<string, WorkspaceId | undefined> {
  if (!nestWorkspaces) return new Map<string, WorkspaceId | undefined>();
  const scopeOf = (workspace: Pick<WorkspaceView, "workspaceId" | "remote">) =>
    `${workspace.remote?.hostId ?? "local"}\n${nativeSectionOf.get(workspace.workspaceId) ?? ""}`;
  const pathsByScope = new Map<string, Map<string, WorkspaceId>>();
  for (const workspace of workspaces) {
    const scope = scopeOf(workspace);
    const paths = pathsByScope.get(scope) ?? new Map<string, WorkspaceId>();
    if (workspace.path) paths.set(workspace.path, workspace.workspaceId);
    pathsByScope.set(scope, paths);
  }
  return new Map<string, WorkspaceId | undefined>(
    workspaces.map((workspace) => {
      if (pinnedWorkspaceIds.has(workspace.workspaceId)) return [workspace.workspaceId, undefined];
      const keysByPath = pathsByScope.get(scopeOf(workspace));
      const path = owningParentFolder(workspace.path, [...(keysByPath?.keys() ?? [])]);
      return [workspace.workspaceId, path === undefined ? undefined : keysByPath?.get(path)];
    }),
  );
}

/**
 * Partition root Workspace groups into Pinned (in `pinnedWorkspaceIds` order), native custom
 * sections (in each section's order, excluding pinned Workspaces), and the default Workspaces
 * section (preserving original order).
 */
export function partitionRootWorkspaceGroups<T extends { readonly key: string }>(
  rootGroups: readonly T[],
  nativeSections: readonly Pick<WorkspaceThreadSection, "id" | "workspaceIds">[],
  pinnedWorkspaceIds: readonly string[],
  sectionOf: ReadonlyMap<string, string>,
): {
  pinnedGroups: T[];
  sectionRoots: Map<string, T[]>;
  workspaceRoots: T[];
} {
  const rootsByKey = new Map(rootGroups.map((group) => [group.key, group]));
  const pinnedGroups = pinnedWorkspaceIds.flatMap((id) => rootsByKey.get(id) ?? []);
  const sectionRoots = new Map(
    nativeSections.map((section) => [
      section.id,
      (section.workspaceIds ?? []).flatMap((id) => {
        const group = rootsByKey.get(id);
        return group !== undefined && sectionOf.get(id) === section.id ? [group] : [];
      }),
    ]),
  );
  const workspaceRoots = rootGroups.filter(
    (group) => group.key !== UNGROUPED_KEY && !sectionOf.has(group.key),
  );
  return { pinnedGroups, sectionRoots, workspaceRoots };
}
