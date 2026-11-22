/** One stable session tab with separate navigation and close controls. */
import { useCallback, useRef, type ReactNode } from "react";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionSummary, SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";
import { IconCloseOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { RecentVisit } from "./recent-visits.ts";
import css from "./RecentShortcut.module.css";

export function RecentShortcut({
  visit,
  summary,
  identity,
  activityLabel,
  activity,
  active,
  closeLabel,
  closeHint,
  open,
  close,
  restoreNavigationFocus,
}: {
  visit: RecentVisit;
  summary: SessionSummary;
  identity: ReactNode;
  activityLabel: string | undefined;
  activity: ReactNode;
  active: boolean;
  closeLabel: string;
  closeHint: string;
  open: (target: SessionTarget) => void;
  close: (sessionId: SessionId) => void;
  restoreNavigationFocus: () => void;
}) {
  const element = useRef<HTMLDivElement | null>(null);
  const bind = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null && element.current?.contains(document.activeElement))
        restoreNavigationFocus();
      element.current = node;
    },
    [restoreNavigationFocus],
  );
  return (
    <div ref={bind} className={css.shortcut} data-active={active || undefined}>
      <button
        type="button"
        className={css.select}
        onMouseDown={(event) => event.preventDefault()}
        title={summary.displayTitle}
        aria-current={active ? "page" : undefined}
        aria-label={[summary.displayTitle, summary.id, activityLabel].filter(Boolean).join(" · ")}
        onClick={() => {
          if (active) return;
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
      <button
        type="button"
        className={css.close}
        onMouseDown={(event) => event.preventDefault()}
        aria-label={closeLabel}
        title={closeHint}
        onClick={() => {
          restoreNavigationFocus();
          close(visit.sessionId);
        }}
      >
        <IconCloseOutlineRegular size={12} />
      </button>
    </div>
  );
}
