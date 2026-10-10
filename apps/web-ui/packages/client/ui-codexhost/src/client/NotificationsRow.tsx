/** Settings row that turns Web Push notifications on or off for this browser. */
import { useEffect, useState, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { pushApi } from "./api.ts";
import {
  disableNotifications,
  enableNotifications,
  notificationState,
  type NotificationState,
} from "./notifications.ts";
import css from "./NotificationsRow.module.css";

export type NotificationsRowProps = PropsRuntime<"settings.general.item"> &
  PropsLocale<"codexhostImport">;

/**
 * Render the notification toggle with its current browser state.
 * @param props - slot props with the locale seat.
 * @returns the row.
 */
export function NotificationsRow({ t }: NotificationsRowProps): ReactNode {
  const [state, setState] = useState<NotificationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void notificationState().then(setState, () => {
      setState("unsupported");
    });
  }, []);

  const run = (action: () => Promise<NotificationState>): void => {
    setBusy(true);
    setError(null);
    action().then(
      (next) => {
        setState(next);
        setBusy(false);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setBusy(false);
      },
    );
  };

  const description = error ?? (state === null ? "" : t(`notifications.${state}`));
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t("notifications.title")}</div>
        <div className={css.desc} role={error === null ? undefined : "alert"}>
          {description}
        </div>
      </div>
      {state === "on" && (
        <button
          type="button"
          className={css.button}
          disabled={busy}
          onClick={() => {
            void pushApi.test();
          }}
        >
          {t("notifications.test")}
        </button>
      )}
      {(state === "off" || state === "on") && (
        <button
          type="button"
          className={css.button}
          disabled={busy}
          onClick={() => {
            run(state === "on" ? disableNotifications : enableNotifications);
          }}
        >
          {state === "on" ? t("notifications.disable") : t("notifications.enable")}
        </button>
      )}
    </div>
  );
}
