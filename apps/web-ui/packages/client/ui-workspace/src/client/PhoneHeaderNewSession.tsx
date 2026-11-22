/** Phone-only New Session trigger housed inside the right-hand glass capsule. */
import { IconNewChatOutlineRegular, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ShortcutCatalogEntry } from "@deepseek-ai/dsh-client-shortcuts/client";
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import css from "./PhoneHeaderNewSession.module.css";

export interface PhoneHeaderNewSessionInjected {
  startSession: () => void;
  hooks: { shortcuts: HostObservable<readonly ShortcutCatalogEntry[]> };
}

export function PhoneHeaderNewSession({
  startSession,
  useShortcuts,
  t,
}: PropsRuntime<"conversation.header.trailing"> &
  PropsLocale<"workspace"> &
  InjectFace<PhoneHeaderNewSessionInjected>) {
  const shortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.new"));
  return (
    <Tooltip
      label={t("actions.newSession")}
      shortcutKeys={shortcut?.keys}
      side="bottom"
      delayMs={500}
    >
      <button
        type="button"
        className={css.button}
        aria-label={t("actions.newSession")}
        aria-keyshortcuts={shortcut?.aria}
        data-phone-new-session
        onClick={() => {
          startSession();
        }}
      >
        <IconNewChatOutlineRegular size={17} className={css.icon} />
      </button>
    </Tooltip>
  );
}
