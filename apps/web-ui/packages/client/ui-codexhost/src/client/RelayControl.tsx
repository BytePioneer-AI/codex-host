import { useId, useState, type ReactNode } from "react";
import { Button, IconCheckCircleOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  webRelayHostSchema,
  webRelayNameSchema,
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
    state.status === "connecting" ||
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
  const official = kind === "official";
  const hostname = official ? relay.officialHostname : relay.customHostname;
  const quotaUntil = current ? relay.quotaUntil : undefined;
  const blocked = relay.enabled && !current;
  const savedDomain = relay.customHost?.startsWith("relay.")
    ? relay.customHost.slice(6)
    : (hostname?.split(".").slice(1).join(".") ?? "");
  const [domain, setDomain] = useState(savedDomain);
  // Preserve an existing nonstandard control endpoint until the user edits its domain.
  const host =
    domain === savedDomain && relay.customHost ? relay.customHost : domain ? `relay.${domain}` : "";
  const hostChanged = host !== (relay.customHost ?? "");
  const validHost = webRelayHostSchema.safeParse(host).success;
  const invalidHost =
    domain !== "" && (!webRelayHostSchema.safeParse(domain).success || (!validHost && hostChanged));
  const hostHint = useId();
  const [name, setName] = useState(official ? "" : (hostname?.split(".")[0] ?? ""));
  const [invite, setInvite] = useState("");
  const nameHint = useId();
  const invalidName =
    name !== "" &&
    (official
      ? !/^[a-z0-9]{4,20}$/.test(name)
      : !webRelayNameSchema.safeParse(name).success ||
        `${name}.${domain}` === host ||
        (domain !== "" && !webRelayHostSchema.safeParse(`${name}.${domain}`).success));
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
              ...(!official ? { name, ...(hostChanged ? { host } : {}) } : {}),
            });
          }}
        >
          {!official && (
            <div className={css.relayFields}>
              <label className={`${css.relayField} ${css.notice}`}>
                {t("connectDevices.selfRelay.host")}
                <input
                  className={css.input}
                  value={domain}
                  placeholder="example.com"
                  onChange={(event) => setDomain(event.target.value.toLowerCase())}
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
              <label className={`${css.relayField} ${css.notice}`}>
                {t("connectDevices.selfRelay.name")}
                <input
                  className={css.input}
                  value={name}
                  placeholder="mycomputer"
                  onChange={(event) => setName(event.target.value.toLowerCase())}
                  aria-invalid={invalidName}
                  aria-describedby={nameHint}
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy || blocked}
                />
              </label>
              <p
                id={nameHint}
                className={invalidName ? css.error : css.meta}
                role={invalidName ? "alert" : undefined}
              >
                {t(
                  invalidName
                    ? "connectDevices.selfRelay.invalidName"
                    : "connectDevices.selfRelay.nameHint",
                )}
              </p>
              <div className={css.relayPreview}>
                <p className={css.notice}>{t("connectDevices.selfRelay.previewTitle")}</p>
                <div className={css.relayPreviewAddress}>
                  <span>https://</span>
                  <span>
                    <strong>{name || t("connectDevices.selfRelay.previewAutoName")}</strong>
                    <small>{t("connectDevices.selfRelay.name")}</small>
                  </span>
                  <span aria-hidden="true">.</span>
                  <span>
                    <strong>{domain || "example.com"}</strong>
                    <small>{t("connectDevices.selfRelay.host")}</small>
                  </span>
                </div>
              </div>
              {host && (
                <p className={css.meta}>{t("connectDevices.selfRelay.address", { host })}</p>
              )}
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
                (official
                  ? hostname === undefined && invalidName
                  : host === "" || invalidHost || invalidName)
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
