/** Explicit phone counterpart of dragging a Session reference into the current draft. */
import { useRef, useState, useSyncExternalStore } from "react";
import {
  IconLinkOutlineRegular,
  MenuItemButton,
  usePhoneSidebar,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ReferenceSessionInjected, SessionMenuItemProps } from "../contract/slots.ts";

const unavailable = () => false;
const noSubscription = () => () => {};

export function ReferenceSessionMenuItem(props: SessionMenuItemProps<ReferenceSessionInjected>) {
  const sidebar = usePhoneSidebar();
  // The provider exists only inside AppFrame's phone drawer, not desktop or native Renderer.
  if (sidebar === null || !sidebar.open) return null;
  return (
    <PhoneReferenceSessionMenuItem key={props.sessionId} {...props} closeDrawer={sidebar.close} />
  );
}

function PhoneReferenceSessionMenuItem({
  sessionId,
  prepareDraftReference,
  closeDrawer,
  useMenuOpenState,
  t,
}: SessionMenuItemProps<ReferenceSessionInjected> & { closeDrawer(): void }) {
  const [action] = useState(() => prepareDraftReference(sessionId));
  const available = useSyncExternalStore(
    action?.subscribe ?? noSubscription,
    action?.getSnapshot ?? unavailable,
  );
  const attempted = useRef(false);
  const [failed, setFailed] = useState(false);
  const [, setMenuOpen] = useMenuOpenState();
  // Keep a captured action visible but disabled while its Composer is unavailable.
  if (action === undefined) return null;
  return (
    <>
      <MenuItemButton
        icon={<IconLinkOutlineRegular />}
        disabled={failed || !available}
        onSelect={() => {
          if (attempted.current) return;
          attempted.current = true;
          try {
            if (action?.insert() === true) {
              setMenuOpen(false);
              closeDrawer();
              return;
            }
          } catch {
            // Keep the menu and draft in place; this activation is never retried.
          }
          setFailed(true);
        }}
      >
        {t("menu.referenceSession")}
      </MenuItemButton>
      {failed && <div role="status">{t("menu.referenceSessionFailed")}</div>}
    </>
  );
}
