import {
  IconBellOutlineRegular,
  IconCheckCircleOutlineRegular,
  MenuItemButton,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { MarkSessionUnreadInjected, SessionMenuItemProps } from "../contract/slots.ts";
import { sessionActivity } from "../tree.ts";

/** Mark a background Session unread without navigating to it. */
export function MarkSessionUnreadMenuItem({
  sessionId,
  useMenuOpenState,
  useSessions,
  useSessionStatus,
  useArchived,
  markCompletionUnread,
  t,
}: SessionMenuItemProps<MarkSessionUnreadInjected>) {
  const [, setMenuOpen] = useMenuOpenState();
  const list = useSessions((snapshot) => snapshot);
  const session = list.byId[sessionId];
  const canMarkUnread = useSessionStatus((statuses) => {
    const status = statuses.get(sessionId);
    if (
      session === undefined ||
      (session.retainedBy.mainView ?? 0) > 0 ||
      status?.completionUnread !== false ||
      status.pendingInteraction !== undefined
    )
      return false;
    const { running, runningSubagentCount } = sessionActivity(session, list, statuses);
    return !running && runningSubagentCount === 0;
  });
  const archived = useArchived((ids) => ids.has(sessionId));
  if (!canMarkUnread || archived) return null;
  return (
    <MenuItemButton
      icon={<IconBellOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false);
        markCompletionUnread(sessionId);
      }}
    >
      {t("menu.markAsUnread")}
    </MenuItemButton>
  );
}

/** Mark all loaded display-tree descendants read without changing selection or expansion. */
export function MarkChildThreadsReadMenuItem({
  markChildThreadsRead,
  useMenuOpenState,
  t,
}: SessionMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState();
  if (markChildThreadsRead === undefined) return null;
  return (
    <MenuItemButton
      icon={<IconCheckCircleOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false);
        markChildThreadsRead();
      }}
    >
      {t("menu.markChildrenAsRead")}
    </MenuItemButton>
  );
}
