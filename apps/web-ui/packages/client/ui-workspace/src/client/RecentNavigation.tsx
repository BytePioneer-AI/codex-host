/** Phone working-set navigation and its shared browser visibility preference. */
import { useRef, useState } from "react";
import type { SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import { IconChevronDownOutlineRegular, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import type { RecentVisit } from "./recent-visits.ts";
import type { RecentNavigationSettings } from "./recent-navigation-settings.ts";
import { RecentShortcut } from "./RecentShortcut.tsx";
import { sessionActivity } from "./tree.ts";
import { sessionStatuses, SessionStatusDots } from "./rows/session-status.tsx";
import css from "./RecentNavigation.module.css";

export interface RecentNavigationInjected {
  hooks: {
    visits: HostObservable<readonly RecentVisit[]>;
    recentNavigationSettings: HostObservable<ConfigFormSnapshot<RecentNavigationSettings>>;
  };
  open: (target: SessionTarget) => void;
  setEnabled: (enabled: boolean) => Promise<boolean>;
}

type NavigationProps = PropsRuntime<"conversation.header.navigation"> &
  PropsLocale<"workspace"> &
  InjectFace<RecentNavigationInjected>;

function useVisitedRows({
  useVisits,
  useSessions,
  useWorkspaces,
  useSessionStatus,
  sessionId,
  t,
}: NavigationProps) {
  const visits = useVisits((value) => value);
  const list = useSessions((value) => value);
  const archived = useWorkspaces((value) => value.archivedSessionIds);
  const statuses = useSessionStatus((value) => value);
  return visits.flatMap((visit) => {
    const summary = list.byId[visit.sessionId];
    if (
      summary === undefined ||
      summary.blank ||
      archived.includes(visit.sessionId) ||
      visit.sessionId === sessionId
    )
      return [];
    return [
      {
        visit,
        summary,
        // Visit navigation shows only actual activity/interaction, not completion reminders.
        statuses: sessionStatuses(
          { ...sessionActivity(summary, list, statuses), completed: false },
          t,
        ),
      },
    ];
  });
}

/** Native horizontal scrolling over the owner's already bounded working set. */
export function RecentShortcuts(
  props: PropsRuntime<"conversation.header.shortcuts"> &
    PropsLocale<"workspace"> &
    InjectFace<RecentNavigationInjected> &
    PropsRenderSlots<"workspace.recent.shortcut.identity">,
) {
  const { useRecentNavigationSettings, open, restoreNavigationFocus, renderSlot, t } = props;
  const enabled = useRecentNavigationSettings((value) => value.value?.showRecentVisits ?? true);
  const rows = useVisitedRows(props);
  if (!enabled || rows.length === 0) return null;
  return (
    <nav className={css.shortcuts} aria-label={t("recent.navigation")}>
      {rows.map(({ visit, summary, statuses }) => (
        <RecentShortcut
          key={visit.sessionId}
          visit={visit}
          summary={summary}
          identity={renderSlot("workspace.recent.shortcut.identity", {
            sessionId: visit.sessionId,
          })}
          activityLabel={
            statuses[0].state === "idle"
              ? undefined
              : statuses.map((status) => status.label).join(" · ")
          }
          activity={statuses[0].state === "idle" ? null : <SessionStatusDots statuses={statuses} />}
          open={open}
          restoreNavigationFocus={restoreNavigationFocus}
        />
      ))}
    </nav>
  );
}

/** The title arrow writes the same accepted browser preference as General Settings. */
export function RecentNavigation(props: NavigationProps) {
  const { useRecentNavigationSettings, setEnabled, t } = props;
  const enabled = useRecentNavigationSettings((value) => value.value?.showRecentVisits ?? true);
  const rows = useVisitedRows(props);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const saving = useRef(false);
  return (
    <>
      {rows.length > 0 && (
        <button
          type="button"
          data-navigation-focus-return
          className={css.trigger}
          aria-label={t(enabled ? "recent.collapse" : "recent.expand")}
          aria-expanded={enabled}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => {
            if (saving.current) return;
            saving.current = true;
            setBusy(true);
            setFailed(false);
            void setEnabled(!enabled)
              .then((saved) => setFailed(!saved))
              .catch(() => setFailed(true))
              .finally(() => {
                saving.current = false;
                setBusy(false);
              });
          }}
        >
          <IconChevronDownOutlineRegular size={14} className={enabled ? css.expanded : undefined} />
        </button>
      )}
      {failed && <Toast text={t("recent.settings.error")} onDone={() => setFailed(false)} />}
    </>
  );
}
