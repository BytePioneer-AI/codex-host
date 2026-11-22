/** Chooses a connection method without changing the listener until the user enables it. */
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Button,
  IconCheckCircleOutlineRegular,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCopyOutlineRegular,
  IconShieldOutlineRegular,
  Menu,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WebAccessState, WebNetworkAccessUrl } from "@codexhost/shared-contracts";
import { copyText } from "./api.ts";
import { QrCode } from "./QrCode.tsx";
import { RelayControl } from "./RelayControl.tsx";
import { SelfHostedRelayHelp } from "./SelfHostedRelayHelp.tsx";
import css from "./ConnectDevicesSection.module.css";

type Translate = PropsLocale<"codexhostImport">["t"];
type Kind = WebNetworkAccessUrl["kind"] | "self-hosted-relay";
const LABEL = {
  public: "connectDevices.kindPublic",
  relay: "connectDevices.relay.title",
  "self-hosted-relay": "connectDevices.selfRelay.title",
  "tailscale-funnel": "connectDevices.kindFunnel",
  "tailscale-https": "connectDevices.kindTailscale",
  tailscale: "connectDevices.kindTailscale",
  lan: "connectDevices.kindLan",
  virtual: "connectDevices.kindVirtual",
} as const;
const HINT: Partial<Record<Kind, Parameters<Translate>[0]>> = {
  public: "connectDevices.kindPublicHint",
  "tailscale-funnel": "connectDevices.kindFunnelHint",
  virtual: "connectDevices.kindVirtualHint",
};
const SUMMARY = {
  "tailscale-https": "connectDevices.httpsSummary",
  relay: "connectDevices.relay.summary",
  "self-hosted-relay": "connectDevices.selfRelay.summary",
  lan: "connectDevices.lanSummary",
} as const;
const PREFERENCE: Kind[] = [
  "public",
  "relay",
  "self-hosted-relay",
  "tailscale-funnel",
  "tailscale-https",
  "tailscale",
  "lan",
  "virtual",
];

export function ConnectionCard({
  data,
  busy,
  restarting,
  onEnable,
  onRelay,
  onRefresh,
  t,
}: {
  data: WebAccessState;
  busy: boolean;
  restarting: boolean;
  onEnable: (method: "direct" | "https") => void;
  onRelay: (
    enabled: boolean,
    settings?: { name?: string; invite?: string; kind?: "official" | "self-hosted"; host?: string },
  ) => void;
  onRefresh: () => void;
  t: Translate;
}): ReactNode {
  const { networkUrls, tailscale, background, secret, relay } = data;
  const relayMethod = relay?.kind === "self-hosted" ? "self-hosted-relay" : "relay";
  const addresses = [
    ...networkUrls,
    ...(data.directCandidates ?? []).filter(
      (entry) => !networkUrls.some((active) => active.url === entry.url),
    ),
  ];
  const [chosenMethod, setMethod] = useState<Kind>();
  // An enabled relay is shown while it prepares, before its address becomes usable.
  const isRelay = (kind: Kind) => kind === "relay" || kind === "self-hosted-relay";
  const relayOn =
    relay !== undefined &&
    (relay.enabled || (relay.state.status === "off" && relay.state.reason !== undefined));
  const method =
    (chosenMethod !== undefined && isRelay(chosenMethod) && relay === undefined
      ? undefined
      : chosenMethod) ??
    PREFERENCE.find((kind) =>
      isRelay(kind)
        ? kind === relayMethod && relayOn
        : networkUrls.some((entry) => entry.kind === kind),
    ) ??
    (addresses.some((entry) => entry.kind === "lan") ? "lan" : "tailscale-https");
  const [selectedUrl, setSelectedUrl] = useState<string>();
  const [revealedLink, setRevealedLink] = useState<string>();
  const [addressMenu, setAddressMenu] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const group = useId();
  const choices = addresses.filter((entry) =>
    entry.kind === "relay" ? method === relayMethod : entry.kind === method,
  );
  const selected = choices.find((entry) => entry.url === selectedUrl) ?? choices[0];
  const ready =
    !restarting &&
    selected !== undefined &&
    networkUrls.some((entry) => entry.url === selected.url);
  const link = ready ? `${selected.url}#token=${secret}` : undefined;
  const revealed = link !== undefined && revealedLink === link;
  const hint = ready ? HINT[method] : undefined;
  const https = method === "tailscale-https";
  const direct = method === "lan" || method === "tailscale" || method === "virtual";
  const canEnable = https
    ? tailscale.status === "not-serving"
    : direct && background !== undefined && !background.lan && selected !== undefined;
  const primaryMethods: Kind[] = [
    ...(relay !== undefined ? (["relay", "self-hosted-relay"] as const) : []),
    "lan",
    "tailscale-https",
  ];
  const extras = PREFERENCE.filter(
    (kind) =>
      kind !== "lan" &&
      !isRelay(kind) &&
      kind !== "tailscale-https" &&
      kind !== "tailscale" &&
      addresses.some((entry) => entry.kind === kind),
  );

  const tailscaleChosen = method === "tailscale-https" || method === "tailscale";
  const hasTailscaleIp = addresses.some((entry) => entry.kind === "tailscale");
  const choose = (kind: Kind): void => {
    setMethod(kind);
    setSelectedUrl(undefined);
  };

  useEffect(() => {
    setCopied("idle");
    setRevealedLink(undefined);
  }, [link]);
  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const routeActive = (kind: Kind): boolean => {
    if (isRelay(kind)) return relay?.enabled === true && kind === relayMethod;
    if (kind === "tailscale-https")
      return networkUrls.some(
        (entry) => entry.kind === "tailscale-https" || entry.kind === "tailscale",
      );
    return networkUrls.some((entry) => entry.kind === kind);
  };

  const routeHost = (kind: Kind): string | undefined => {
    if (isRelay(kind)) return kind === "relay" ? relay?.officialHost : relay?.customHost;
    const shown =
      kind === "tailscale-https" && tailscaleChosen
        ? selected
        : kind === "tailscale-https"
          ? (addresses.find((entry) => entry.kind === kind) ??
            addresses.find((entry) => entry.kind === "tailscale"))
          : kind === method
            ? selected
            : addresses.find((entry) => entry.kind === kind);
    return shown === undefined ? undefined : new URL(shown.url).host;
  };

  const primaryOption = (kind: Kind): ReactNode => {
    const checked = kind === "tailscale-https" ? tailscaleChosen : method === kind;
    const active = routeActive(kind);
    return (
      <label
        key={kind}
        className={css.methodCard}
        data-connect-route={kind}
        data-selected={checked}
      >
        <input
          type="radio"
          name={group}
          checked={checked}
          disabled={busy}
          onChange={() => choose(kind)}
        />
        <span className={css.routeText}>
          <span className={css.routeTitle}>
            <span>{t(LABEL[kind])}</span>
            {active && <span className={css.activeBadge}>{t("connectDevices.relay.inUse")}</span>}
          </span>
          {(kind === "lan" ||
            kind === "tailscale-https" ||
            kind === "relay" ||
            kind === "self-hosted-relay") && <span className={css.meta}>{t(SUMMARY[kind])}</span>}
        </span>
      </label>
    );
  };

  const advancedOption = (kind: Kind): ReactNode => {
    const checked = method === kind;
    const active = routeActive(kind);
    return (
      <label key={kind} className={css.route} data-connect-route={kind}>
        <input
          type="radio"
          name={group}
          checked={checked}
          disabled={busy}
          onChange={() => choose(kind)}
        />
        <span className={css.routeText}>
          <span className={css.routeTitle}>
            <span>{t(LABEL[kind])}</span>
            {active && <span className={css.activeBadge}>{t("connectDevices.relay.inUse")}</span>}
            <span className={css.routeAddress}>{routeHost(kind)}</span>
          </span>
        </span>
      </label>
    );
  };

  return (
    <section className={css.connectionCard}>
      <div className={css.methodBar}>
        <fieldset className={css.routes} disabled={busy}>
          <legend className={css.fieldTitle}>{t("connectDevices.connectVia")}</legend>
          <div className={css.methodGrid}>{primaryMethods.map(primaryOption)}</div>
        </fieldset>
      </div>
      <div className={css.connectionMain}>
        <div className={css.scan}>
          {link !== undefined ? (
            <button
              type="button"
              className={css.qrButton}
              aria-label={t(revealed ? "connectDevices.hideQr" : "connectDevices.viewQr")}
              aria-pressed={revealed}
              disabled={busy}
              onClick={() => setRevealedLink(revealed ? undefined : link)}
            >
              <span className={css.qrFrame}>
                <QrCode
                  value={link}
                  label={t("connectDevices.qrLabel")}
                  className={revealed ? css.qr : `${css.qr} ${css.qrObscured}`}
                />
                {!revealed && (
                  <span className={css.qrCover} aria-hidden="true">
                    <IconShieldOutlineRegular size={22} />
                    <span>{t("connectDevices.viewQr")}</span>
                    <small>{t("connectDevices.qrSensitive")}</small>
                  </span>
                )}
              </span>
              {revealed && <span className={css.qrAction}>{t("connectDevices.hideQr")}</span>}
            </button>
          ) : (
            <div className={css.qrPlaceholder}>
              <IconShieldOutlineRegular size={28} />
              <span>{t(restarting ? "connectDevices.preparing" : "connectDevices.qrPending")}</span>
            </div>
          )}
        </div>
        <div className={css.connectionDetails}>
          {tailscaleChosen && hasTailscaleIp && (
            <div className={css.subRoutes} role="radiogroup" aria-label="Tailscale">
              <label className={css.subRoute}>
                <input
                  type="radio"
                  name={`${group}-tailscale`}
                  checked={method === "tailscale-https"}
                  disabled={busy}
                  onChange={() => choose("tailscale-https")}
                />
                {t("connectDevices.tailscaleViaHttps")}
              </label>
              <label className={css.subRoute} data-connect-route="tailscale">
                <input
                  type="radio"
                  name={`${group}-tailscale`}
                  checked={method === "tailscale"}
                  disabled={busy}
                  onChange={() => choose("tailscale")}
                />
                {t("connectDevices.tailscaleViaIp")}
              </label>
            </div>
          )}
          {isRelay(method) && relay !== undefined && (
            <RelayControl
              key={method}
              kind={method === "relay" ? "official" : "self-hosted"}
              relay={relay}
              busy={busy}
              onChange={onRelay}
              onRefresh={onRefresh}
              t={t}
            />
          )}
          {!isRelay(method) && (!ready || hint !== undefined) && (
            <div
              className={css.connectionHelp}
              data-tailscale-status={
                https && tailscale.status !== "serving" ? tailscale.status : undefined
              }
            >
              {hint !== undefined ? (
                <p className={css.ready}>
                  <IconCheckCircleOutlineRegular />
                  <span>{t(hint)}</span>
                </p>
              ) : restarting ? (
                <p role="status" className={css.notice}>
                  {t("connectDevices.restarting")}
                </p>
              ) : https ? (
                <>
                  <p className={css.notice}>
                    {t(
                      tailscale.status === "not-serving"
                        ? "connectDevices.httpsSetup"
                        : tailscale.status === "serving"
                          ? "connectDevices.refreshHint"
                          : `connectDevices.tailscale.${tailscale.status}`,
                    )}
                  </p>
                  {tailscale.status === "occupied" && (
                    <p className={css.meta}>{tailscale.target}</p>
                  )}
                  {tailscale.status === "error" && <p className={css.error}>{tailscale.message}</p>}
                  {tailscale.status === "not-installed" && (
                    <a
                      className={css.link}
                      href="https://tailscale.com/download"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("connectDevices.remote.tailscaleLink")}
                    </a>
                  )}
                  {tailscale.status === "https-disabled" && (
                    <a
                      className={css.link}
                      href="https://login.tailscale.com/admin/dns"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("connectDevices.openTailscale")}
                    </a>
                  )}
                  {tailscale.status === "not-serving" && (
                    <p className={css.meta}>{t("connectDevices.httpsPersistence")}</p>
                  )}
                </>
              ) : (
                <p className={css.notice}>
                  {t(
                    canEnable
                      ? "connectDevices.enableImpact"
                      : background === undefined
                        ? "connectDevices.localListener"
                        : "connectDevices.noAddress",
                  )}
                </p>
              )}
              {!ready && !restarting && (
                <div className={css.actions}>
                  {canEnable && (
                    <Button
                      variant="primary"
                      disabled={busy}
                      aria-busy={busy}
                      onClick={() => onEnable(https ? "https" : "direct")}
                    >
                      {t(busy ? "connectDevices.preparing" : "connectDevices.enableQr")}
                    </Button>
                  )}
                  {(https || !canEnable) && (
                    <Button variant="outline" disabled={busy} onClick={onRefresh}>
                      {t("connectDevices.refresh")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {selected !== undefined && (
            <div className={css.addressBlock}>
              {ready && !isRelay(method) && hint === undefined && (
                <p className={css.ready}>
                  <IconCheckCircleOutlineRegular />
                  <span>{t("connectDevices.readyHint")}</span>
                </p>
              )}
              <div className={css.addressRow}>
                {choices.length > 1 ? (
                  <Menu
                    open={addressMenu}
                    onClose={() => setAddressMenu(false)}
                    portal
                    className={css.addressMenu}
                    anchor={
                      <button
                        aria-label={t("connectDevices.address")}
                        type="button"
                        className={`${css.input} ${css.addressTrigger}`}
                        disabled={busy}
                        aria-haspopup="menu"
                        aria-expanded={addressMenu}
                        onClick={() => setAddressMenu(!addressMenu)}
                      >
                        <span>{new URL(selected.url).host}</span>
                        <IconChevronDownOutlineRegular />
                      </button>
                    }
                    items={choices.map((entry) => ({
                      id: entry.url,
                      label: new URL(entry.url).host,
                    }))}
                    selectedId={selected.url}
                    onSelect={(url) => {
                      setAddressMenu(false);
                      setSelectedUrl(url);
                    }}
                  />
                ) : (
                  <input
                    aria-label={t("connectDevices.address")}
                    className={css.input}
                    value={new URL(selected.url).host}
                    readOnly
                  />
                )}
                {link !== undefined && (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => {
                      void copyText(link).then(
                        () => setCopied("copied"),
                        () => setCopied("failed"),
                      );
                    }}
                  >
                    {copied === "copied" ? (
                      <IconCheckOutlineRegular size={14} />
                    ) : (
                      <IconCopyOutlineRegular size={14} />
                    )}
                    <span>
                      {t(
                        copied === "copied"
                          ? "connectDevices.copied"
                          : copied === "failed"
                            ? "connectDevices.copyFailed"
                            : "connectDevices.copyLink",
                      )}
                    </span>
                  </Button>
                )}
              </div>
            </div>
          )}
          {method === "self-hosted-relay" && relay !== undefined && <SelfHostedRelayHelp t={t} />}
        </div>
      </div>
      {extras.length > 0 && (
        <div className={css.moreMethods}>
          <details className={css.other} open={extras.includes(method) ? true : undefined}>
            <summary>{t("connectDevices.otherMethods")}</summary>
            <div className={css.extraRoutes}>{extras.map(advancedOption)}</div>
          </details>
        </div>
      )}
    </section>
  );
}
