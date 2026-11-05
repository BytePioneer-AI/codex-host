/** Web settings page that connects other devices: the access token's QR code, shown only on this computer. */
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Button, Modal, relativeTime } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  webLocalAccessRequiredDetailsSchema,
  type WebAccessState,
  type WebNetworkAccessUrl,
} from "@codexhost/shared-contracts";
import { accessTokenApi, ApiError } from "./api.ts";
import { signOut } from "./auth-watch.ts";
import { QrCode } from "./QrCode.tsx";
import css from "./ConnectDevicesSection.module.css";

type Translate = PropsLocale<"codexhostImport">["t"];

type View =
  | { kind: "loading" }
  | { kind: "ready"; data: WebAccessState }
  | { kind: "non-local"; url: string }
  | { kind: "disabled" }
  | { kind: "failed"; message: string };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function viewOfError(error: unknown): View {
  if (error instanceof ApiError && error.code === "auth/disabled") return { kind: "disabled" };
  if (error instanceof ApiError && error.code === "auth/local-access-required") {
    const details = webLocalAccessRequiredDetailsSchema.safeParse(error.details);
    return { kind: "non-local", url: details.success ? details.data.url : "http://127.0.0.1" };
  }
  return { kind: "failed", message: messageOf(error) };
}

function CopyButton({
  value,
  label,
  t,
}: {
  value: string;
  label: string;
  t: Translate;
}): ReactNode {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <Button
      variant="outline"
      className={css.copy}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      {state === "copied"
        ? t("connectDevices.copied")
        : state === "failed"
          ? t("connectDevices.copyFailed")
          : label}
    </Button>
  );
}

/** A value to select by hand with its copy action. */
function CopyField({
  label,
  value,
  copyLabel,
  t,
}: {
  label: string;
  value: string;
  copyLabel: string;
  t: Translate;
}): ReactNode {
  return (
    <div className={css.copyField}>
      <input
        className={css.input}
        aria-label={label}
        readOnly
        value={value}
        onFocus={(event) => event.currentTarget.select()}
      />
      <CopyButton value={value} label={copyLabel} t={t} />
    </div>
  );
}

const KIND_LABEL = {
  public: "connectDevices.kindPublic",
  "tailscale-funnel": "connectDevices.kindFunnel",
  "tailscale-https": "connectDevices.kindTailscaleHttps",
  tailscale: "connectDevices.kindTailscale",
  lan: "connectDevices.kindLan",
  virtual: "connectDevices.kindVirtual",
} as const;
const KIND_HINT = {
  public: "connectDevices.kindPublicHint",
  "tailscale-funnel": "connectDevices.kindFunnelHint",
  "tailscale-https": "connectDevices.kindTailscaleHttpsHint",
  tailscale: "connectDevices.kindTailscaleHint",
  lan: "connectDevices.kindLanHint",
  virtual: "connectDevices.kindVirtualHint",
} as const;

/** The QR code and link of the chosen address; best address first, virtual ones folded. */
function Connection({
  secret,
  addresses,
  t,
}: {
  secret: string;
  addresses: WebNetworkAccessUrl[];
  t: Translate;
}): ReactNode {
  const [selectedUrl, setSelectedUrl] = useState(addresses[0]?.url);
  const [enlarged, setEnlarged] = useState(false);
  const group = useId();
  const selected = addresses.find((entry) => entry.url === selectedUrl) ?? addresses[0];
  if (selected === undefined) return null;
  const link = `${selected.url}#token=${secret}`;
  const preferred = addresses.filter((entry) => entry.kind !== "virtual");
  const virtual = addresses.filter((entry) => entry.kind === "virtual");
  const option = (entry: WebNetworkAccessUrl): ReactNode => (
    <label key={entry.url} className={css.route} data-connect-route={entry.kind}>
      <input
        type="radio"
        name={group}
        checked={entry.url === selected.url}
        onChange={() => setSelectedUrl(entry.url)}
      />
      <span className={css.routeText}>
        <span className={css.routeTitle}>
          {t(KIND_LABEL[entry.kind])}
          <span className={css.routeAddress}>{new URL(entry.url).host}</span>
        </span>
        <span className={css.meta}>{t(KIND_HINT[entry.kind])}</span>
      </span>
    </label>
  );
  return (
    <div className={css.connection}>
      <div className={css.connectionMain} data-enlarged={enlarged ? true : undefined}>
        <button
          type="button"
          className={css.qrButton}
          aria-label={t(enlarged ? "connectDevices.shrinkQr" : "connectDevices.enlargeQr")}
          aria-pressed={enlarged}
          onClick={() => setEnlarged((value) => !value)}
        >
          <QrCode value={link} label={t("connectDevices.qrLabel")} className={css.qr} />
        </button>
        <fieldset className={css.routes}>
          <legend className={css.fieldTitle}>{t("connectDevices.connectVia")}</legend>
          {preferred.map(option)}
          {virtual.length > 0 && (
            <details className={css.other} open={preferred.length === 0}>
              <summary>{t("connectDevices.otherAddresses", { count: virtual.length })}</summary>
              <div className={css.otherList}>{virtual.map(option)}</div>
            </details>
          )}
        </fieldset>
      </div>
      <CopyField
        key={link}
        label={t("connectDevices.signInLink")}
        value={link}
        copyLabel={t("connectDevices.copyLink")}
        t={t}
      />
      {selected.kind === "public" && selected.url.startsWith("http:") && (
        <p className={css.notice}>{t("connectDevices.publicHttp")}</p>
      )}
      <p className={css.meta}>{t("connectDevices.linkPrivate")}</p>
    </div>
  );
}

const REMOTE_ACCESS_DOC =
  "https://github.com/BytePioneer-AI/codex-host/blob/main/docs/product/web-remote-access.md";

/** Collapsed explanation of the ways to reach this computer from outside its network. */
function RemoteOptions({ t }: { t: Translate }): ReactNode {
  const option = (title: string, body: string, href: string, linkLabel: string): ReactNode => (
    <div className={css.routeText}>
      <span className={css.routeTitle}>{title}</span>
      <span className={css.meta}>{body}</span>
      <a className={css.link} href={href} target="_blank" rel="noreferrer">
        {linkLabel}
      </a>
    </div>
  );
  return (
    <details className={css.other} data-remote-options>
      <summary>{t("connectDevices.remote.title")}</summary>
      <div className={css.remoteList}>
        {option(
          "Tailscale",
          t("connectDevices.remote.tailscale"),
          "https://tailscale.com/download",
          t("connectDevices.remote.tailscaleLink"),
        )}
        {option(
          t("connectDevices.remote.tunnelTitle"),
          t("connectDevices.remote.tunnel"),
          REMOTE_ACCESS_DOC,
          t("connectDevices.remote.tunnelLink"),
        )}
      </div>
    </details>
  );
}

function Confirm({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onClose,
  onConfirm,
  t,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
  t: Translate;
}): ReactNode {
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      closeLabel={t("connectDevices.close")}
      description={description}
      className={css.confirm}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("connectDevices.cancel")}
          </Button>
          <Button
            variant="primary"
            className={css.dangerConfirm}
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error !== null && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

/** What a phone or other device sees here: where to find the token, and a way to sign out. */
function ElsewhereNotice({ url, t }: { url: string; t: Translate }): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={css.page}>
      <p className={css.notice} data-connect-notice="non-local">
        {t("connectDevices.localOnly", { url })}
      </p>
      <div>
        <Button variant="outline" onClick={() => setConfirming(true)}>
          {t("connectDevices.signOut")}
        </Button>
      </div>
      {confirming && (
        <Confirm
          t={t}
          title={t("connectDevices.signOutTitle")}
          description={t("connectDevices.signOutDescription")}
          confirmLabel={t("connectDevices.signOutConfirm")}
          busy={busy}
          error={error}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setBusy(true);
            setError(null);
            void signOut().catch((cause: unknown) => {
              setBusy(false);
              setError(t("connectDevices.actionFailed", { message: messageOf(cause) }));
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * @param props - slot props with the locale seat.
 * @returns the QR code on this computer, guidance and sign-out elsewhere.
 */
export function ConnectDevicesSection({ t }: PropsLocale<"codexhostImport">): ReactNode {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setView({ kind: "ready", data: await accessTokenApi.get() });
    } catch (cause) {
      setView(viewOfError(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (view.kind === "loading") return <p className={css.meta}>{t("connectDevices.loading")}</p>;
  if (view.kind === "non-local") return <ElsewhereNotice url={view.url} t={t} />;
  if (view.kind === "disabled")
    return (
      <p className={css.notice} data-connect-notice="disabled">
        {t("connectDevices.disabled")}
      </p>
    );
  if (view.kind === "failed")
    return (
      <p className={css.error} role="alert">
        {t("connectDevices.loadFailed", { message: view.message })}
      </p>
    );

  const { secret, lastUsedAt, networkUrls, tailscale } = view.data;
  const used = lastUsedAt === null ? undefined : relativeTime(lastUsedAt, Date.now());
  return (
    <div className={css.page} data-connect-devices>
      <p className={css.description}>{t("connectDevices.description")}</p>
      {networkUrls.length > 0 ? (
        <Connection secret={secret} addresses={networkUrls} t={t} />
      ) : (
        <div className={css.connection}>
          <p className={css.notice}>{t("connectDevices.localListener")}</p>
          <CopyField
            key={secret}
            label={t("connectDevices.token")}
            value={secret}
            copyLabel={t("connectDevices.copy")}
            t={t}
          />
        </div>
      )}
      {tailscale.status !== "serving" && (
        <div className={css.connection} data-tailscale-status={tailscale.status}>
          <h3 className={css.fieldTitle}>Tailscale</h3>
          <p className={css.notice}>{t(`connectDevices.tailscale.${tailscale.status}`)}</p>
          {tailscale.status === "occupied" && <p className={css.meta}>{tailscale.target}</p>}
          {tailscale.status === "error" && <p className={css.error}>{tailscale.message}</p>}
          {tailscale.status === "not-serving" && (
            <>
              <CopyField
                label={t("connectDevices.serveCommand")}
                value={tailscale.command}
                copyLabel={t("connectDevices.copyCommand")}
                t={t}
              />
              <p className={css.meta}>{t("connectDevices.servePersists")}</p>
            </>
          )}
        </div>
      )}
      <RemoteOptions t={t} />
      <div className={css.footer}>
        <span
          className={css.meta}
          title={lastUsedAt === null ? undefined : new Date(lastUsedAt).toLocaleString()}
        >
          {used === undefined
            ? t("connectDevices.neverUsed")
            : t("connectDevices.lastUsed", {
                time: t(`connectDevices.relative.${used.unit}`, { n: used.n }),
              })}
        </span>
        <div className={css.actions}>
          {networkUrls.length > 0 && (
            <CopyButton key={secret} value={secret} label={t("connectDevices.copyToken")} t={t} />
          )}
          <Button
            variant="ghost"
            className={css.danger}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            {t("connectDevices.regenerate")}
          </Button>
        </div>
      </div>
      {confirming && (
        <Confirm
          t={t}
          title={t("connectDevices.regenerateTitle")}
          description={t("connectDevices.regenerateDescription")}
          confirmLabel={t("connectDevices.regenerateConfirm")}
          busy={busy}
          error={error}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setBusy(true);
            setError(null);
            void accessTokenApi
              .regenerate()
              .then((data) => {
                setView({ kind: "ready", data });
                setConfirming(false);
              })
              .catch((cause: unknown) => {
                setError(t("connectDevices.actionFailed", { message: messageOf(cause) }));
              })
              .finally(() => setBusy(false));
          }}
        />
      )}
    </div>
  );
}
