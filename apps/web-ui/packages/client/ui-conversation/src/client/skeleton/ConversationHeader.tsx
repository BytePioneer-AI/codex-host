/** Resident conversation navigation and Session-specific header content. */
import clsx from "clsx";
import type { ConversationHeaderProps } from "../contract/slots.ts";
import { conversationPhase } from "../contract/snapshot.ts";
import css from "./ConversationRoot.module.css";

/** A Session-maybe header remounts on selection; resolve its current focus surface after commit. */
function restoreNavigationFocus(): void {
  const focus = (): void => {
    const header = document.querySelector<HTMLElement>("[data-conversation-navigation-focus]");
    const control = header?.querySelector<HTMLElement>("[data-navigation-focus-return]");
    const target =
      control !== undefined && control !== null && control.getClientRects().length > 0
        ? control
        : header;
    target?.focus({ preventScroll: true });
  };
  focus();
  requestAnimationFrame(() => {
    if (document.activeElement === document.body) focus();
  });
}

/**
 * Keeps global navigation available before a Session exists.
 * @param props - Optional Session sources and authorized header slots.
 * @returns The persistent header with any selected Session's title and views.
 */
export function ConversationHeader({
  sessionId,
  useSession,
  useConversation,
  renderSlot,
}: ConversationHeaderProps) {
  const session = useSession((s) => s);
  const conversation = useConversation((s) => s);
  const blank =
    session === undefined ||
    conversation === undefined ||
    (session.blank && conversationPhase(session, conversation) === "blank");
  return (
    <header
      className={clsx(
        css.header,
        blank && css.headerBlank,
        sessionId === undefined && css.headerSessionless,
      )}
      data-window-drag
      data-conversation-navigation-focus
      tabIndex={-1}
    >
      <div className={css.headerLeading} data-conversation-header-leading="">
        {renderSlot("conversation.header.leading", {})}
      </div>
      {sessionId === undefined ? (
        <div className={css.titleRow}>
          {renderSlot("conversation.header.navigation", { restoreNavigationFocus })}
        </div>
      ) : (
        renderSlot("conversation.session.header", {
          hideChrome: blank,
          titleNavigation: renderSlot("conversation.header.navigation", { restoreNavigationFocus }),
        })
      )}
      {renderSlot("conversation.header.shortcuts", { restoreNavigationFocus })}
    </header>
  );
}
