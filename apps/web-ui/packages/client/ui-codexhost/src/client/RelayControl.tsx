import type { ReactNode } from "react";
import { Button, IconCheckCircleOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
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

/** The relay's part of the connection card: what it is before enabling, then its state. */
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
  const usable = state.status === "connected" && !paused;
  const message = usable
    ? t("connectDevices.relay.hint")
    : state.status === "stopped"
      ? t(`connectDevices.relay.${state.reason}`)
      : paused
        ? t("connectDevices.relay.paused")
        : state.status === "off"
          ? t("connectDevices.relay.off")
          : relayPreparing(state)
            ? t("connectDevices.relay.preparing")
            : t("connectDevices.relay.unavailable", {
                date: new Date(failure?.retryAt ?? "").toLocaleString(),
              });
  return (
    <div className={css.connectionHelp} data-relay-status={state.status}>
      <p className={usable ? css.ready : css.notice} role="status">
        {usable && <IconCheckCircleOutlineRegular />}
        <span>{message}</span>
      </p>
      {paused && (
        <p className={css.meta}>{failure.detail ?? t("connectDevices.relay.unreachable")}</p>
      )}
      {state.status === "off" && (
        <p className={css.meta}>{t("connectDevices.relay.identity", { path: identityPath })}</p>
      )}
      <div className={css.actions}>
        {state.status === "off" ? (
          <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => onChange(true)}>
            {t(busy ? "connectDevices.preparing" : "connectDevices.relay.enable")}
          </Button>
        ) : (
          <>
            {!usable && (
              <Button variant="outline" disabled={busy} onClick={onRefresh}>
                {t("connectDevices.refresh")}
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => onChange(false)}>
              {t("connectDevices.relay.disable")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
