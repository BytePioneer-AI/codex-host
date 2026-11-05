/** Controls are mounted only for authenticated local access to a background Web. */
import { useEffect, useState, type ReactNode } from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WebAccessState, WebBackgroundState } from "@codexhost/shared-contracts";
import { accessTokenApi } from "./api.ts";
import css from "./ConnectDevicesSection.module.css";

export function BackgroundControls({
  state,
  restored,
  t,
}: {
  state: WebBackgroundState;
  restored: (data: WebAccessState) => void;
  t: PropsLocale<"codexhostImport">["t"];
}): ReactNode {
  const [restarting, setRestarting] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (restarting === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const data = await accessTokenApi.get();
        if (cancelled) return;
        if (data.background?.lan === restarting) {
          restored(data);
          setRestarting(null);
          return;
        }
      } catch (cause) {
        if (cancelled) return;
        // Connection failures are expected while the supervisor restarts Web.
        if (!(cause instanceof TypeError)) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRestarting(null);
          return;
        }
      }
      if (!cancelled)
        timer = setTimeout(() => {
          void check();
        }, 1_000);
    };
    timer = setTimeout(() => {
      void check();
    }, 1_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [restarting, restored]);

  return (
    <section className={css.connection} data-background-controls>
      <p className={css.notice}>{t("connectDevices.background")}</p>
      <div className={css.setting}>
        <span className={css.notice}>{t("connectDevices.lan")}</span>
        <Switch
          label={t("connectDevices.lan")}
          checked={state.lan}
          disabled={busy || restarting !== null}
          onChange={(enabled) => {
            setBusy(true);
            setError(undefined);
            void accessTokenApi
              .lan(enabled)
              .then(({ changed }) => {
                if (changed) setRestarting(enabled);
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
              })
              .finally(() => setBusy(false));
          }}
        />
      </div>
      <p className={css.meta}>{t("connectDevices.lanHint")}</p>
      <div className={css.setting}>
        <span className={css.notice}>{t("connectDevices.autostart")}</span>
        <Switch
          label={t("connectDevices.autostart")}
          checked={state.autostart.status === "on"}
          disabled={busy || restarting !== null}
          onChange={(enabled) => {
            setBusy(true);
            setError(undefined);
            void accessTokenApi
              .autostart(enabled)
              .then(async () => {
                restored(await accessTokenApi.get());
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
              })
              .finally(() => setBusy(false));
          }}
        />
      </div>
      {state.autostart.status === "invalid" && (
        <p className={css.error}>{state.autostart.reason}</p>
      )}
      <p className={css.meta}>{t("connectDevices.sleep")}</p>
      {restarting !== null && (
        <p role="status" className={css.notice}>
          {t("connectDevices.restarting")}
        </p>
      )}
      {error !== undefined && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
    </section>
  );
}
