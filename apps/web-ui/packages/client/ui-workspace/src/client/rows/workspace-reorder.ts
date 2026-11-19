/** Reordering is a local workspace operation, including its drop target. */
export function canReorderLocalWorkspaces(
  workspaces: readonly { workspaceId: string; remote?: { hostId: string } }[],
  sourceId: string,
  targetId: string | undefined,
): boolean {
  const source = workspaces.find((w) => w.workspaceId === sourceId);
  const target = workspaces.find((w) => w.workspaceId === targetId);
  return source !== undefined && target !== undefined && !source.remote && !target.remote;
}
