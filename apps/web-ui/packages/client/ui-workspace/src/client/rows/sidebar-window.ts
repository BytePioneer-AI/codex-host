/** A presentation window over the existing catalog, not a second history or paging source. */
interface SidebarRow {
  id: string;
  blank: boolean;
  pinned: boolean;
  running: boolean;
  runningSubagentCount: number;
}

export const GROUP_INITIAL_ROWS = 5;
export const SIDEBAR_PAGE_ROWS = 10;
export const WORKSPACE_INITIAL_ROWS = 5;

/** Important rows remain reachable without expanding every older conversation. */
export function sidebarWindow<T extends SidebarRow>(
  sessions: readonly T[],
  limit: number,
  currentId?: string,
  revealId?: string,
): { rows: readonly T[]; hiddenCount: number } {
  let ordinary = 0;
  const rows = sessions.filter((session) => {
    if (session.blank || session.pinned || session.running || session.runningSubagentCount > 0)
      return true;
    return ordinary++ < limit || session.id === currentId || session.id === revealId;
  });
  return { rows, hiddenCount: sessions.length - rows.length };
}

/**
 * Window over root Workspace rows, not over their Sessions. The leading rows
 * stay stable; `keepKeys` additionally reveals required rows outside that window
 * in their original positions.
 * @param groups - root Workspaces in render order.
 * @param limit - leading Workspaces shown before the reveal control.
 * @param keepKeys - root keys that always stay visible.
 * @returns the visible rows in order plus the hidden row count.
 */
export function workspaceWindow<T extends { key: string }>(
  groups: readonly T[],
  limit: number,
  keepKeys: ReadonlySet<string>,
): { rows: readonly T[]; hiddenCount: number } {
  const rows = groups.filter((group, index) => index < limit || keepKeys.has(group.key));
  return { rows, hiddenCount: groups.length - rows.length };
}
