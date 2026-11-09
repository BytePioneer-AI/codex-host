/** Chooses a connection method without changing the listener until the user enables it. */
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Button,
  IconCheckCircleOutlineRegular,
  IconChevronDownOutlineRegular,
  IconShieldOutlineRegular,
  Menu,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WebAccessState, WebNetworkAccessUrl } from "@codexhost/shared-contracts";
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
  const [enlarged, setEnlarged] = useState(false);
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
  const hint = ready ? HINT[method] : undefined;
  const https = method === "tailscale-https";
  const direct = method === "lan" || method === "tailscale" || method === "virtual";
  const canEnable = https
    ? tailscale.status === "not-serving"
    : direct && background !== undefined && !background.lan && selected !== undefined;
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
  }, [link]);
  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

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

  const option = (kind: Kind): ReactNode => (
    <label key={kind} className={css.route} data-connect-route={kind}>
      <input
        type="radio"
        name={group}
        checked={kind === "tailscale-https" ? tailscaleChosen : method === kind}
        disabled={busy}
        onChange={() => choose(kind)}
      />
      <span className={css.routeText}>
        <span className={css.routeTitle}>
          {t(LABEL[kind])}
          {isRelay(kind) && relay?.enabled && kind === relayMethod && (
            <span className={css.badge}>{t("connectDevices.relay.inUse")}</span>
          )}
          <span className={css.routeAddress}>{routeHost(kind)}</span>
        </span>
        {(kind === "lan" ||
          kind === "tailscale-https" ||
          kind === "relay" ||
          kind === "self-hosted-relay") && <span className={css.meta}>{t(SUMMARY[kind])}</span>}
      </span>
    </label>
  );

  return (
    <section className={css.connection}>
      <div className={css.connectionMain}>
        <div className={css.scan}>
          {link !== undefined ? (
            <button
              type="button"
              className={css.qrButton}
              aria-label={t("connectDevices.enlargeQr")}
              disabled={busy}
              onClick={() => setEnlarged(true)}
            >
              <QrCode value={link} label={t("connectDevices.qrLabel")} className={css.qr} />
            </button>
          ) : (
            <div className={css.qrPlaceholder}>
              <IconShieldOutlineRegular size={32} />
              <span>{t(restarting ? "connectDevices.preparing" : "connectDevices.qrPending")}</span>
            </div>
          )}
        </div>
        <div className={css.connectionDetails}>
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
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void navigator.clipboard.writeText(link).then(
                      () => setCopied("copied"),
                      () => setCopied("failed"),
                    );
                  }}
                >
                  {t(
                    copied === "copied"
                      ? "connectDevices.copied"
                      : copied === "failed"
                        ? "connectDevices.copyFailed"
                        : "connectDevices.copyLink",
                  )}
                </Button>
              )}
            </div>
          )}
          {method === "self-hosted-relay" && relay !== undefined && <SelfHostedRelayHelp t={t} />}
        </div>
      </div>
      <div className={css.routePanel}>
        <fieldset className={css.routes} disabled={busy}>
          <legend className={css.fieldTitle}>{t("connectDevices.connectVia")}</legend>
          <div className={css.routeGroup}>
            {relay !== undefined && (
              <>
                {option("relay")}
                {option("self-hosted-relay")}
              </>
            )}
            <div className={css.routeFamily}>
              {option("tailscale-https")}
              {tailscaleChosen && hasTailscaleIp && (
                <div className={css.subRoutes}>
                  <label className={css.subRoute}>
                    <input
                      type="radio"
                      name={`${group}-tailscale`}
                      checked={method === "tailscale-https"}
                      onChange={() => choose("tailscale-https")}
                    />
                    {t("connectDevices.tailscaleViaHttps")}
                  </label>
                  <label className={css.subRoute} data-connect-route="tailscale">
                    <input
                      type="radio"
                      name={`${group}-tailscale`}
                      checked={method === "tailscale"}
                      onChange={() => choose("tailscale")}
                    />
                    {t("connectDevices.tailscaleViaIp")}
                  </label>
                </div>
              )}
            </div>
            {option("lan")}
          </div>
        </fieldset>
        {extras.length > 0 && (
          <details className={css.other} open={extras.includes(method) ? true : undefined}>
            <summary>{t("connectDevices.otherMethods")}</summary>
            <div className={css.extraRoutes}>{extras.map(option)}</div>
          </details>
        )}
      </div>
      {enlarged && link !== undefined && (
        <Modal
          open
          onClose={() => setEnlarged(false)}
          title={t("connectDevices.scan")}
          closeLabel={t("connectDevices.close")}
          className={css.qrModal}
        >
          <QrCode value={link} label={t("connectDevices.qrLabel")} className={css.largeQr} />
        </Modal>
      )}
    </section>
  );
}
