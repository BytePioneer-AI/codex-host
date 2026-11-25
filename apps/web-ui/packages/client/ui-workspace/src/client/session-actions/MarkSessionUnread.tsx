import { IconBellOutlineRegular, MenuItemButton } from "@deepseek-ai/dsh-client-ui-primitives";
import type { MarkSessionUnreadInjected, SessionMenuItemProps } from "../contract/slots.ts";

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
  const background = useSessions(({ byId }) => {
    const session = byId[sessionId];
    return session !== undefined && (session.retainedBy.mainView ?? 0) === 0;
  });
  const read = useSessionStatus((statuses) => statuses.get(sessionId)?.completionUnread === false);
  const archived = useArchived((ids) => ids.has(sessionId));
  if (!background || !read || archived) return null;
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
