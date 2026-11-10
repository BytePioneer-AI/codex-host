/** Stable phone session tabs and their shared browser visibility preference. */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
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
  close: (sessionId: SessionId) => void;
  /** Root-owned presentation state survives Session-maybe header remounts. */
  viewport: { scrollLeft: number };
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
  t,
}: NavigationProps) {
  const visits = useVisits((value) => value);
  const list = useSessions((value) => value);
  const archived = useWorkspaces((value) => value.archivedSessionIds);
  const statuses = useSessionStatus((value) => value);
  return visits.flatMap((visit) => {
    const summary = list.byId[visit.sessionId];
    if (summary === undefined || summary.blank || archived.includes(visit.sessionId)) return [];
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

/** Session switching changes selection, never tab order or the saved horizontal viewport. */
export function RecentShortcuts(
  props: PropsRuntime<"conversation.header.shortcuts"> &
    PropsLocale<"workspace"> &
    InjectFace<RecentNavigationInjected> &
    PropsRenderSlots<"workspace.recent.shortcut.identity">,
) {
  const {
    useRecentNavigationSettings,
    open,
    close,
    viewport,
    restoreNavigationFocus,
    renderSlot,
    t,
  } = props;
  const enabled = useRecentNavigationSettings((value) => value.value?.showRecentVisits ?? true);
  const rows = useVisitedRows(props);
  const visible = enabled && rows.length > 0;
  const strip = useRef<HTMLElement | null>(null);
  const [closeFailed, setCloseFailed] = useState(false);
  const rememberScroll = useCallback(
    (node: HTMLElement | null = strip.current) => {
      if (node?.isConnected && node.clientWidth > 0) {
        viewport.scrollLeft = Math.max(
          0,
          Math.min(node.scrollLeft, node.scrollWidth - node.clientWidth),
        );
      }
    },
    [viewport],
  );
  useLayoutEffect(() => {
    const node = strip.current;
    if (node === null) return;
    // The header is Session-scoped: restore before paint, without focusing or revealing a tab.
    node.scrollLeft = viewport.scrollLeft;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      node.scrollLeft = viewport.scrollLeft;
    });
    observer.observe(node);
    return () => {
      rememberScroll(node);
      observer.disconnect();
    };
  }, [visible, viewport, rememberScroll]);
  if (!visible) return null;
  return (
    <>
      <nav
        ref={strip}
        className={css.shortcuts}
        aria-label={t("recent.navigation")}
        onScroll={(event) => rememberScroll(event.currentTarget)}
      >
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
            activity={
              statuses[0].state === "idle" ? null : <SessionStatusDots statuses={statuses} />
            }
            active={props.sessionId === visit.sessionId}
            closeLabel={t("recent.close", { name: summary.displayTitle })}
            closeHint={t("recent.closeHint")}
            open={(target) => {
              rememberScroll();
              open(target);
            }}
            close={(sessionId) => {
              rememberScroll();
              try {
                close(sessionId);
              } catch {
                setCloseFailed(true);
              }
            }}
            restoreNavigationFocus={restoreNavigationFocus}
          />
        ))}
      </nav>
      {closeFailed && <Toast text={t("recent.closeFailed")} onDone={() => setCloseFailed(false)} />}
    </>
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
