export interface ReorderableWorkspace {
  readonly workspaceId: string;
  readonly remote?: { readonly hostId: string } | undefined;
}

export interface WorkspaceReorderContext {
  readonly sectionOf?: ReadonlyMap<string, string> | ReadonlySet<string> | undefined;
  readonly parents?: ReadonlyMap<string, string | undefined> | undefined;
}

export interface WorkspaceDropAnchor {
  readonly beforeWorkspaceId: string | undefined;
}

function isSectioned(
  sectionOf: WorkspaceReorderContext["sectionOf"],
  workspaceId: string,
): boolean {
  return sectionOf !== undefined && sectionOf.has(workspaceId);
}

/**
 * Whether `sourceId` can be reordered onto `targetId` across local and remote workspaces.
 * Rejects unknown IDs, self-drops, Desktop native-section workspaces, and cross-parent nested rows.
 */
export function canReorderWorkspaces(
  workspaces: readonly ReorderableWorkspace[],
  sourceId: string,
  targetId: string | undefined,
  context: WorkspaceReorderContext = {},
): boolean {
  if (targetId === undefined || sourceId === targetId) return false;
  const source = workspaces.find((workspace) => workspace.workspaceId === sourceId);
  const target = workspaces.find((workspace) => workspace.workspaceId === targetId);
  if (source === undefined || target === undefined) return false;
  if (isSectioned(context.sectionOf, sourceId) || isSectioned(context.sectionOf, targetId)) {
    return false;
  }
  if (
    context.parents !== undefined &&
    context.parents.get(sourceId) !== context.parents.get(targetId)
  ) {
    return false;
  }
  return true;
}

/**
 * Resolve the `beforeWorkspaceId` anchor for dropping `sourceId` before or after `over.id`.
 * Evaluates against the full same-parent non-sectioned sibling list (including collapsed or
 * host-filtered siblings) so dropping after the last visible row stays immediately after it.
 * Returns `null` when the drop is invalid or leaves the order unchanged.
 */
export function resolveWorkspaceDropAnchor(
  allWorkspaces: readonly ReorderableWorkspace[],
  sourceId: string,
  over: { readonly id: string; readonly half: "before" | "after" },
  context: WorkspaceReorderContext = {},
): WorkspaceDropAnchor | null {
  if (!canReorderWorkspaces(allWorkspaces, sourceId, over.id, context)) return null;
  const owner = context.parents?.get(sourceId);
  const siblings = allWorkspaces.filter(
    (workspace) =>
      !isSectioned(context.sectionOf, workspace.workspaceId) &&
      context.parents?.get(workspace.workspaceId) === owner,
  );
  const rowIndex = siblings.findIndex((workspace) => workspace.workspaceId === over.id);
  const sourceIndex = siblings.findIndex((workspace) => workspace.workspaceId === sourceId);
  if (rowIndex === -1 || sourceIndex === -1) return null;
  const anchor = over.half === "before" ? over.id : siblings[rowIndex + 1]?.workspaceId;
  if (anchor === sourceId) return null;
  const anchorIndex =
    anchor === undefined
      ? siblings.length
      : siblings.findIndex((workspace) => workspace.workspaceId === anchor);
  if (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1) return null;
  return { beforeWorkspaceId: anchor };
}
