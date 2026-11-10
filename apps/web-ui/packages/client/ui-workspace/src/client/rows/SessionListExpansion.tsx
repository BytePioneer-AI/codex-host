import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import { SIDEBAR_PAGE_ROWS } from "./sidebar-window.ts";
import css from "./WorkspaceBrowser.module.css";

type Props = Pick<WorkspaceBrowserProps, "loadMoreSessions" | "t"> & {
  rowKey: string;
  hiddenCount: number;
  hasMore?: boolean;
  loading?: boolean;
  expanded?: boolean;
  expand: () => void;
  collapse?: () => void;
};

/** The existing inline reveal action also requests one older page when local rows run out. */
export function SessionListExpansion({
  rowKey,
  hiddenCount,
  hasMore,
  loading,
  expanded,
  expand,
  collapse,
  loadMoreSessions,
  t,
}: Props) {
  if (hiddenCount === 0 && !hasMore && !collapse) return null;
  const fetching = hiddenCount === 0 && hasMore && loading;
  return (
    <button
      type="button"
      data-row-key={rowKey}
      className={css.sessionOverflowButton}
      aria-expanded={expanded}
      disabled={fetching}
      onClick={() => {
        if (hiddenCount > 0) expand();
        else if (hasMore) {
          expand();
          loadMoreSessions();
        } else collapse?.();
      }}
    >
      {fetching
        ? t("sessions.loading")
        : hiddenCount > 0
          ? t("sessions.expand", { n: Math.min(SIDEBAR_PAGE_ROWS, hiddenCount) })
          : hasMore
            ? t("sessions.expandMore")
            : t("sessions.collapse")}
    </button>
  );
}
