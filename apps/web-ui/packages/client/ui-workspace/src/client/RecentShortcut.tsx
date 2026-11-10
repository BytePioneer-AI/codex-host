/** One visit shortcut; its caller supplies the authorized public identity presentation. */
import { useCallback, useRef, type ReactNode } from "react";
import type { SessionSummary, SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";
import type { RecentVisit } from "./recent-visits.ts";
import css from "./RecentShortcut.module.css";

export function RecentShortcut({
  visit,
  summary,
  identity,
  activityLabel,
  activity,
  open,
  restoreNavigationFocus,
}: {
  visit: RecentVisit;
  summary: SessionSummary;
  identity: ReactNode;
  activityLabel: string | undefined;
  activity: ReactNode;
  open: (target: SessionTarget) => void;
  restoreNavigationFocus: () => void;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const bind = useCallback(
    (node: HTMLButtonElement | null) => {
      if (node === null && button.current === document.activeElement) restoreNavigationFocus();
      button.current = node;
    },
    [restoreNavigationFocus],
  );
  return (
    <button
      ref={bind}
      type="button"
      className={css.shortcut}
      title={summary.displayTitle}
      aria-label={[summary.displayTitle, summary.id, activityLabel].filter(Boolean).join(" · ")}
      onClick={() => {
        restoreNavigationFocus();
        open(visit.target);
      }}
    >
      <span className={css.identity}>{identity}</span>
      <span className={css.title}>{summary.displayTitle}</span>
      {activity !== null && activity !== undefined && (
        <span className={css.activity} title={activityLabel}>
          {activity}
        </span>
      )}
    </button>
  );
}
