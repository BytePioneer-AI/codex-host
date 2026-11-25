/** Controls are mounted only for authenticated local access to a background Web. */
import { useEffect, useState, type ReactNode } from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WebAccessState, WebBackgroundState } from "@codexhost/shared-contracts";
import { accessTokenApi } from "./api.ts";
import css from "./ConnectDevicesSection.module.css";

type Translate = PropsLocale<"codexhostImport">["t"];

export interface DirectRestart {
  /** The listening state Web is restarting into, or null when it is not restarting. */
  target: boolean | null;
  error: string | undefined;
  start: (enabled: boolean) => void;
  fail: (message: string | undefined) => void;
}

/** Waits for Web to return with the requested listener before offering connection links. */
export function useDirectRestart(
  restored: (data: WebAccessState) => void,
  timeoutMessage: string,
): DirectRestart {
  const [target, setTarget] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (target === null) return;
    let cancelled = false;
    const deadline = Date.now() + 60_000;
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
      if (Date.now() >= deadline) {
        setError(timeoutMessage);
        setTarget(null);
        return;
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
  }, [target, restored, timeoutMessage]);
  return { target, error, start: setTarget, fail: setError };
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
    <div className={css.manageRow} data-background-controls>
      <div className={css.manageText}>
        <span className={css.manageTitle}>{t("connectDevices.autostart")}</span>
        {state.autostart.status === "invalid" && (
          <span className={css.error}>{state.autostart.reason}</span>
        )}
        {error !== undefined && (
          <span role="alert" className={css.error}>
            {error}
          </span>
        )}
      </div>
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
  );
}
