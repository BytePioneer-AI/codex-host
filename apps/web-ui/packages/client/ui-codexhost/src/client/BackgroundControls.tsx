/** Controls are mounted only for authenticated local access to a background Web. */
import { useEffect, useState, type ReactNode } from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WebAccessState, WebBackgroundState } from "@codexhost/shared-contracts";
import { accessTokenApi } from "./api.ts";
import { SwitchConfirm } from "./SwitchConfirm.tsx";
import css from "./ConnectDevicesSection.module.css";

type Translate = PropsLocale<"codexhostImport">["t"];

export interface DirectRestart {
  /** The listening state Web is restarting into, or null when it is not restarting. */
  target: boolean | null;
  error: string | undefined;
  start: (enabled: boolean) => void;
  fail: (message: string | undefined) => void;
}

/** Waits for Web to return with the requested listener; lives above the remountable route list. */
export function useDirectRestart(restored: (data: WebAccessState) => void): DirectRestart {
  const [target, setTarget] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (target === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const data = await accessTokenApi.get();
        if (cancelled) return;
        if (data.background?.lan === target) {
          restored(data);
          setTarget(null);
          return;
        }
      } catch (cause) {
        if (cancelled) return;
        // Connection failures are expected while the supervisor restarts Web.
        if (!(cause instanceof TypeError)) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setTarget(null);
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
  }, [target, restored]);
  return { target, error, start: setTarget, fail: setError };
}

export function DirectControl({
  enabled,
  restart,
  t,
}: {
  enabled: boolean;
  restart: DirectRestart;
  t: Translate;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = t("connectDevices.direct");
  return (
    <>
      <div className={css.setting}>
        <span className={css.groupTitle}>{label}</span>
        <Switch
          label={label}
          checked={enabled}
          disabled={restart.target !== null}
          onChange={() => {
            restart.fail(undefined);
            setConfirming(true);
          }}
        />
      </div>
      {restart.target !== null && (
        <p role="status" className={css.notice}>
          {t("connectDevices.restarting")}
        </p>
      )}
      {restart.error !== undefined && (
        <p role="alert" className={css.error}>
          {restart.error}
        </p>
      )}
      {confirming && (
        <SwitchConfirm
          t={t}
          title={t(enabled ? "connectDevices.directOff" : "connectDevices.directOn")}
          description={t(
            enabled ? "connectDevices.directOffConfirm" : "connectDevices.directOnConfirm",
          )}
          busy={busy}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setBusy(true);
            void accessTokenApi
              .lan(!enabled)
              .then(({ changed }) => {
                if (changed) restart.start(!enabled);
              })
              .catch((cause: unknown) => {
                restart.fail(cause instanceof Error ? cause.message : String(cause));
              })
              .finally(() => {
                setBusy(false);
                setConfirming(false);
              });
          }}
        />
      )}
    </>
  );
}

export function AutostartControl({
  state,
  disabled,
  restored,
  t,
}: {
  state: WebBackgroundState;
  disabled: boolean;
  restored: (data: WebAccessState) => void;
  t: Translate;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <section className={css.connection} data-background-controls>
      <div className={css.setting}>
        <span className={css.notice}>{t("connectDevices.autostart")}</span>
        <Switch
          label={t("connectDevices.autostart")}
          checked={state.autostart.status === "on"}
          disabled={busy || disabled}
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
      {error !== undefined && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
    </section>
  );
}
