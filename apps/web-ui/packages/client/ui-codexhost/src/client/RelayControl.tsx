import type { ReactNode } from "react";
import { Button, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WebAccessState } from "@codexhost/shared-contracts";
import css from "./ConnectDevicesSection.module.css";

type RelayState = NonNullable<WebAccessState["relay"]>["state"];

/**
 * Registration and the first certificate are one "preparing" step for users; certificates are an
 * implementation detail that surfaces only when a failure needs their attention.
 */
export function relayPreparing(state: RelayState): boolean {
  return (
    state.status === "connecting" ||
    (state.status === "missing-certificate" && state.certificate.failure === undefined)
  );
}

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
  const failure = "certificate" in state ? state.certificate.failure : undefined;
  // Renewal runs while the current certificate still works, so only a pause needs the user.
  const paused = failure?.paused === true;
  const message =
    state.status === "stopped"
      ? t(`connectDevices.relay.${state.reason}`)
      : paused
        ? t("connectDevices.relay.paused")
        : state.status === "off" || state.status === "connected"
          ? t(`connectDevices.relay.${state.status}`)
          : relayPreparing(state)
            ? t("connectDevices.relay.preparing")
            : t("connectDevices.relay.unavailable", {
                date: new Date(failure?.retryAt ?? "").toLocaleString(),
              });
  return (
    <div className={css.manageRow} data-relay-status={state.status}>
      <div className={css.manageText}>
        <span className={css.manageTitle}>{t("connectDevices.relay.title")}</span>
        <span className={css.notice} role="status">
          {message}
        </span>
        {paused && (
          <span className={css.meta}>
            {failure.detail ?? t("connectDevices.relay.unreachable")}
          </span>
        )}
        {state.status === "connected" && <span className={css.meta}>{state.url}</span>}
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
