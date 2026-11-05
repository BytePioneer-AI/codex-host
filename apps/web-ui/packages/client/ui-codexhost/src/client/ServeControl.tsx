/** The switch for the only Tailscale configuration writes exposed by Web. */
import { useState, type ReactNode } from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { accessTokenApi } from "./api.ts";
import { SwitchConfirm } from "./SwitchConfirm.tsx";
import css from "./ConnectDevicesSection.module.css";

export function ServeControl({
  enabled,
  disabled,
  command,
  refresh,
  t,
}: {
  enabled: boolean;
  disabled: boolean;
  /** Manual alternative, offered in the dialog that enables Serve. */
  command?: ReactNode;
  refresh: (preferServe: boolean) => Promise<void>;
  t: PropsLocale<"codexhostImport">["t"];
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const label = t("connectDevices.kindTailscaleHttps");
  return (
    <>
      <div className={css.setting}>
        <span className={css.groupTitle}>{label}</span>
        <Switch
          label={label}
          checked={enabled}
          disabled={disabled}
          onChange={() => {
            setError(undefined);
            setConfirming(true);
          }}
        />
      </div>
      {error !== undefined && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
      {confirming && (
        <SwitchConfirm
          t={t}
          title={t(enabled ? "connectDevices.serveOff" : "connectDevices.serveOn")}
          description={t(
            enabled ? "connectDevices.serveOffConfirm" : "connectDevices.serveOnConfirm",
          )}
          busy={busy}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setBusy(true);
            void (async () => {
              try {
                const result = await accessTokenApi.serve(!enabled);
                setError(result.error);
                await refresh(!enabled && result.error === undefined);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
                setConfirming(false);
              }
            })();
          }}
        >
          {!enabled && command}
        </SwitchConfirm>
      )}
    </>
  );
}
