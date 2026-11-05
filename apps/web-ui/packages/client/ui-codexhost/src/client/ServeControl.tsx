/** Confirmation for the only Tailscale configuration writes exposed by Web. */
import { useState, type ReactNode } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { accessTokenApi } from "./api.ts";
import css from "./ConnectDevicesSection.module.css";

export function ServeControl({
  enabled,
  available,
  refresh,
  t,
}: {
  enabled: boolean;
  available: boolean;
  refresh: (preferServe: boolean) => Promise<void>;
  t: PropsLocale<"codexhostImport">["t"];
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const label = t(enabled ? "connectDevices.serveOff" : "connectDevices.serveOn");
  return (
    <div className={css.connection}>
      {available && (
        <>
          <Button
            variant="outline"
            onClick={() => {
              setError(undefined);
              setConfirming(true);
            }}
          >
            {label}
          </Button>
          <p className={css.meta}>{t("connectDevices.serveRetained")}</p>
        </>
      )}
      {error !== undefined && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
      {confirming && (
        <Modal
          open
          title={label}
          description={t(
            enabled ? "connectDevices.serveOffConfirm" : "connectDevices.serveOnConfirm",
          )}
          closeLabel={t("connectDevices.close")}
          onClose={() => {
            if (!busy) setConfirming(false);
          }}
          className={css.confirm}
          footer={
            <>
              <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                {t("connectDevices.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => {
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
                {label}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
