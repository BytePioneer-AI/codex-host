/** Settings row that turns Web Push notifications on or off for this browser. */
import { useEffect, useState, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import {
  disableNotifications,
  enableNotifications,
  notificationState,
  sendTestNotification,
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
  const [testing, setTesting] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void notificationState().then(setState, () => {
      setState("unsupported");
    });
  }, []);

  const run = (action: () => Promise<NotificationState>): void => {
    setBusy(true);
    setError(null);
    setTestSent(false);
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

  const description =
    error ??
    (testSent ? t("notifications.testSent") : state === null ? "" : t(`notifications.${state}`));
  const test = (): void => {
    setTesting(true);
    setError(null);
    setTestSent(false);
    void sendTestNotification()
      .then((sent) => {
        if (sent) setTestSent(true);
        else setError(t("notifications.testNotSent"));
      })
      .catch(() => setError(t("notifications.testFailed")))
      .finally(() => setTesting(false));
  };
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t("notifications.title")}</div>
        <div className={css.desc} role={error !== null ? "alert" : testSent ? "status" : undefined}>
          {description}
        </div>
      </div>
      {(state === "off" || state === "on") && (
        <div className={css.actions}>
          {state === "on" && (
            <button
              type="button"
              className={css.button}
              disabled={busy || testing}
              aria-busy={testing}
              onClick={() => {
                test();
              }}
            >
              {t(testing ? "notifications.testing" : "notifications.test")}
            </button>
          )}
          <button
            type="button"
            className={css.button}
            disabled={busy || testing}
            onClick={() => {
              run(state === "on" ? disableNotifications : enableNotifications);
            }}
          >
            {state === "on" ? t("notifications.disable") : t("notifications.enable")}
          </button>
        </div>
      )}
    </div>
  );
}
