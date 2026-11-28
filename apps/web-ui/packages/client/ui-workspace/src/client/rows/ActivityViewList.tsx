/**
 * Sidebar Activity View list: renders pending, running, and unread-completed
 * sessions with a compact header bar for one-click "Mark all read".
 */
import clsx from "clsx";
import type { PropsRenderSlots } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import type { ActivityViewProjection } from "../activity-view.ts";
import type { SessionNode } from "../tree.ts";
import { AnimatedRows } from "./AnimatedRows.tsx";
import { SessionNodeItem } from "./Rows.tsx";
import { ThreadTreeRows } from "./ThreadTreeControls.tsx";
import { useThreadTreeView } from "./ThreadTreeView.tsx";
import browserCss from "./WorkspaceBrowser.module.css";
import css from "./ActivityViewList.module.css";

/** Minimal 3-bar descending filter icon aligned with 16x16 regular sidebar glyphs. */
export function ActivityFilterIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.5h11" />
      <path d="M4.5 8h7" />
      <path d="M6.5 11.5h3" />
    </svg>
  );
}

export interface ActivityViewListProps extends PropsRenderSlots<
  | "sidebar.workspaces.session.menu.item"
  | "sidebar.workspaces.session.row.action"
  | "sidebar.session.row.identity"
  | "sidebar.session.row.leading"
  | "sidebar.session.row.hover"
> {
  projection: ActivityViewProjection;
  currentId: SessionId | undefined;
  ready: boolean;
  animationResetKey: string;
  singleRemoteHostScoped?: boolean;
  onOpen: (id: SessionNode["id"]) => void;
  onSessionRenameRequest: (id: SessionNode["id"], currentTitle: string) => void;
  onMarkAllRead: (sessionIds: readonly SessionId[]) => void;
  onExit: () => void;
  t: WorkspaceBrowserProps["t"];
}

export function ActivityViewList({
  projection,
  currentId,
  ready,
  animationResetKey,
  singleRemoteHostScoped = false,
  onOpen,
  onSessionRenameRequest,
  onMarkAllRead,
  onExit,
  renderSlot,
  t,
}: ActivityViewListProps) {
  const threadView = useThreadTreeView();
  const { rows, unreadSessionIds, unreadCount } = projection;
  const now = Date.now();
  const rowKeys =
    rows.length === 0
      ? ["empty:activity"]
      : threadView.rows(rows).map((row) => `session:${row.id}`);

  return (
    <div className={clsx(browserCss.treeBody, browserCss.wide)}>
      <div className={css.toolbar} role="region" aria-label={t("activityView.label")}>
        <div className={css.titleGroup}>
          <span className={css.title}>{t("activityView.label")}</span>
          {unreadCount > 0 && (
            <span className={css.unreadMeta}>
              {t(
                unreadCount === 1
                  ? "activityView.unreadCount.one"
                  : "activityView.unreadCount.other",
                { n: unreadCount },
              )}
            </span>
          )}
        </div>
        <button
          type="button"
          className={css.markAllReadButton}
          disabled={unreadCount === 0}
          onClick={() => {
            onMarkAllRead(unreadSessionIds);
          }}
        >
          {t("activityView.markAllRead")}
        </button>
      </div>
      <AnimatedRows
        className={clsx(browserCss.list, browserCss.flatList)}
        label={t("activityView.label")}
        rowKeys={rowKeys}
        ready={ready}
        resetKey={animationResetKey}
      >
        {rows.length === 0 ? (
          <div className={css.emptyState} data-row-key="empty:activity">
            <ActivityFilterIcon size={22} className={css.emptyIcon} />
            <div className={css.emptyTitle}>{t("activityView.empty")}</div>
            <button type="button" className={css.backButton} onClick={onExit}>
              {t("activityView.backToAll")}
            </button>
          </div>
        ) : (
          <ThreadTreeRows roots={rows}>
            {(node) => (
              <SessionNodeItem
                key={node.id}
                node={node}
                showHost={!singleRemoteHostScoped}
                currentId={currentId}
                now={now}
                onOpen={onOpen}
                onRenameRequest={onSessionRenameRequest}
                renderSlot={renderSlot}
                t={t}
              />
            )}
          </ThreadTreeRows>
        )}
      </AnimatedRows>
      <span className={browserCss.fade} />
    </div>
  );
}
