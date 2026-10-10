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
