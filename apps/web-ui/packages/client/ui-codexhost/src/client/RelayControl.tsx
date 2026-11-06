import type { ReactNode } from "react";
import { Button, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WebAccessState } from "@codexhost/shared-contracts";
import css from "./ConnectDevicesSection.module.css";

export function RelayControl({
  relay,
  busy,
  onChange,
  onRefresh,
  t,
}: {
  relay: NonNullable<WebAccessState["relay"]>;
  busy: boolean;
  onChange(enabled: boolean): void;
  onRefresh(): void;
  t: PropsLocale<"codexhostImport">["t"];
}): ReactNode {
  const { state, identityPath } = relay;
  return (
    <div className={css.manageRow} data-relay-status={state.status}>
      <div className={css.manageText}>
        <span className={css.manageTitle}>{t("connectDevices.relay.title")}</span>
        <span className={css.notice} role="status">
          {t(
            state.status === "stopped"
              ? `connectDevices.relay.${state.reason}`
              : `connectDevices.relay.${state.status}`,
          )}
        </span>
        {(state.status === "connected" || state.status === "missing-certificate") && (
          <span className={css.meta}>{state.url}</span>
        )}
        <span className={css.meta}>
          {t("connectDevices.relay.identity", { path: identityPath })}
        </span>
      </div>
      <div className={css.manageActions}>
        <Button variant="outline" disabled={busy} onClick={onRefresh}>
          {t("connectDevices.refresh")}
        </Button>
        <Switch
          label={t("connectDevices.relay.title")}
          checked={state.status !== "off"}
          disabled={busy}
          onChange={onChange}
        />
      </div>
    </div>
  );
}
