/** Copy a shared Thread address without retaining or opening its history. */
import { IconCopyOutlineRegular, MenuItemButton } from "@deepseek-ai/dsh-client-ui-primitives";
import { threadReferenceOf } from "@deepseek-ai/dsh-client-ui-conversation/thread-reference";
import type { CopySessionLinkInjected, SessionMenuItemProps } from "../contract/slots.ts";

export function CopySessionLinkMenuItem({
  sessionId,
  useSessions,
  useMenuOpenState,
  copySessionLink,
  t,
}: SessionMenuItemProps<CopySessionLinkInjected>) {
  const available = useSessions((list) => {
    const session = list.byId[sessionId];
    return session !== undefined && threadReferenceOf(session) !== undefined;
  });
  const [, setMenuOpen] = useMenuOpenState();
  if (!available) return null;
  return (
    <MenuItemButton
      icon={<IconCopyOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false);
        copySessionLink(sessionId);
      }}
    >
      {t("menu.copySessionLink")}
    </MenuItemButton>
  );
}
