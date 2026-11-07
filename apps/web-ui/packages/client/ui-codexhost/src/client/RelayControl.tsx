import { useId, useState, type ReactNode } from "react";
import { Button, IconCheckCircleOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  webRelayHostSchema,
  type WebAccessState,
  type WebRelayKind,
} from "@codexhost/shared-contracts";
import css from "./ConnectDevicesSection.module.css";

type RelayState = NonNullable<WebAccessState["relay"]>["state"];

/**
 * Registration and the first certificate are one "preparing" step for users; certificates are an
 * implementation detail that surfaces only when a failure needs their attention.
 */
export function relayPreparing(state: RelayState): boolean {
  return (
    (state.status === "connecting" && state.reason !== "unreachable") ||
    (state.status === "missing-certificate" && state.certificate.failure === undefined)
  );
}

/** The relay's part of the connection card: what it is before enabling, then its state. */
export function RelayControl({
  kind,
  relay,
  busy,
  onChange,
  onRefresh,
  t,
}: {
  kind: WebRelayKind;
  relay: NonNullable<WebAccessState["relay"]>;
  busy: boolean;
  onChange(
    enabled: boolean,
    settings?: { name?: string; invite?: string; kind?: WebRelayKind; host?: string },
  ): void;
  onRefresh(): void;
  t: PropsLocale<"codexhostImport">["t"];
}): ReactNode {
  const current = kind === relay.kind;
  const state: RelayState = current ? relay.state : { status: "off" };
  const hostname = current ? relay.hostname : undefined;
  const quotaUntil = current ? relay.quotaUntil : undefined;
  const official = kind === "official";
  const blocked = relay.enabled && !current;
  const [host, setHost] = useState(relay.customHost ?? "");
  const hostChanged = host !== (relay.customHost ?? "");
  const validHost = webRelayHostSchema.safeParse(host).success;
  const invalidHost = host !== "" && !validHost && hostChanged;
  const hostHint = useId();
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const nameHint = useId();
  const invalidName = name !== "" && !/^[a-z0-9]{4,20}$/.test(name);
  const failure = "certificate" in state ? state.certificate.failure : undefined;
  // Renewal runs while the current certificate still works, so only a pause needs the user.
  const paused = failure?.paused === true;
  const usable = state.status === "connected" && !paused && quotaUntil === undefined;
  const message =
    quotaUntil !== undefined
      ? t("connectDevices.relay.quota")
      : state.status === "off" && state.reason !== undefined
        ? t(`connectDevices.relay.${state.reason}`)
        : state.status === "connecting" && state.reason !== undefined
          ? t(
              state.reason === "full"
                ? "connectDevices.relay.full"
                : "connectDevices.relay.connectionFailed",
            )
          : usable
            ? t("connectDevices.relay.hint")
            : state.status === "stopped"
              ? t(`connectDevices.relay.${state.reason}`)
              : paused
                ? t("connectDevices.relay.paused")
                : state.status === "off"
                  ? t(official ? "connectDevices.relay.off" : "connectDevices.selfRelay.off")
                  : relayPreparing(state)
                    ? t("connectDevices.relay.preparing")
                    : t("connectDevices.relay.unavailable", {
                        date: new Date(failure?.retryAt ?? "").toLocaleString(),
                      });
  return (
    <div className={css.connectionHelp} data-relay-status={state.status}>
      {official && <p className={css.meta}>{relay.officialHost}</p>}
      {!official && current && relay.enabled && (
        <p className={css.meta}>
          {t("connectDevices.selfRelay.address", { host: relay.customHost ?? "" })}
        </p>
      )}
      {blocked && <p className={css.notice}>{t("connectDevices.relay.closeFirst")}</p>}
      <p className={usable ? css.ready : css.notice} role="status">
        {usable && <IconCheckCircleOutlineRegular />}
        <span>{message}</span>
      </p>
      {quotaUntil !== undefined && (
        <p className={css.meta}>
          {t("connectDevices.relay.quotaUntil", { date: new Date(quotaUntil).toLocaleString() })}
        </p>
      )}
      {paused && (
        <p className={css.meta}>{failure.detail ?? t("connectDevices.relay.unreachable")}</p>
      )}
      {state.status === "off" ? (
        <form
          className={css.connectionHelp}
          onSubmit={(event) => {
            event.preventDefault();
            onChange(true, {
              kind,
              ...(official && hostname === undefined ? { name, invite } : {}),
              ...(!official && hostChanged ? { host } : {}),
            });
          }}
        >
          {!official && (
            <div className={css.relayFields}>
              <label className={`${css.relayField} ${css.notice}`}>
                {t("connectDevices.selfRelay.host")}
                <input
                  className={css.input}
                  value={host}
                  onChange={(event) => setHost(event.target.value.toLowerCase())}
                  aria-invalid={invalidHost}
                  aria-describedby={hostHint}
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy || blocked}
                />
              </label>
              <p
                id={hostHint}
                className={invalidHost ? css.error : css.meta}
                role={invalidHost ? "alert" : undefined}
              >
                {t(
                  invalidHost
                    ? "connectDevices.selfRelay.invalidHost"
                    : "connectDevices.selfRelay.hostHint",
                )}
              </p>
            </div>
          )}
          {official && hostname === undefined && (
            <div className={css.relayFields}>
              <label className={`${css.relayField} ${css.notice}`}>
                {t("connectDevices.relay.name")}
                <input
                  className={css.input}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  pattern="[a-z0-9]{4,20}"
                  aria-invalid={invalidName}
                  aria-describedby={nameHint}
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              <p id={nameHint} className={css.meta}>
                {t("connectDevices.relay.nameHint")}
              </p>
              <label className={`${css.relayField} ${css.notice}`}>
                {t("connectDevices.relay.inviteLabel")}
                <input
                  className={css.input}
                  value={invite}
                  onChange={(event) => setInvite(event.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
            </div>
          )}
          <div className={css.actions}>
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy ||
                blocked ||
                (official ? hostname === undefined && invalidName : host === "" || invalidHost)
              }
              aria-busy={busy}
            >
              {t(busy ? "connectDevices.preparing" : "connectDevices.relay.enable")}
            </Button>
          </div>
        </form>
      ) : (
        <div className={css.actions}>
          {!usable && (
            <Button variant="outline" disabled={busy} onClick={onRefresh}>
              {t("connectDevices.refresh")}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => onChange(false, { kind })}>
            {t("connectDevices.relay.disable")}
          </Button>
        </div>
      )}
    </div>
  );
}
