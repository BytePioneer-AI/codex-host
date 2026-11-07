/** Connection setup is local-only; other devices get guidance and sign-out. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Modal, relativeTime } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  webLocalAccessRequiredDetailsSchema,
  type WebAccessState,
} from "@codexhost/shared-contracts";
import { accessTokenApi, ApiError } from "./api.ts";
import { signOut } from "./auth-watch.ts";
import { AutostartControl, useDirectRestart } from "./BackgroundControls.tsx";
import { relayPreparing } from "./RelayControl.tsx";
import { ConnectionCard } from "./ConnectionCard.tsx";
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

/** One explicit action enables the chosen route; selecting it only previews its address. */
export function ConnectDevicesSection({ t }: PropsLocale<"codexhostImport">): ReactNode {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [confirming, setConfirming] = useState<"regenerate" | "stop" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const restored = useCallback((data: WebAccessState) => setView({ kind: "ready", data }), []);
  const restart = useDirectRestart(restored, t("connectDevices.restartTimeout"));
  const working = busy || restart.target !== null;

  useEffect(() => {
    if (!tokenCopied) return;
    const timer = setTimeout(() => setTokenCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [tokenCopied]);

  useEffect(() => {
    let cancelled = false;
    void accessTokenApi.get().then(
      (data) => {
        if (!cancelled) setView({ kind: "ready", data });
      },
      (cause: unknown) => {
        if (!cancelled) setView(viewOfError(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const relayState = view.kind === "ready" ? view.data.relay?.state : undefined;
  const relaySettling = relayState !== undefined && relayPreparing(relayState);
  useEffect(() => {
    if (!relaySettling) return;
    // Registration and the first certificate finish in the background; follow them until they settle.
    const timer = setTimeout(() => {
      void accessTokenApi.get().then(restored, () => undefined);
    }, 2_000);
    return () => clearTimeout(timer);
  }, [relaySettling, view, restored]);
  const refresh = async (): Promise<WebAccessState> => {
    const data = await accessTokenApi.get();
    restored(data);
    return data;
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    restart.fail(undefined);
    try {
      await action();
    } catch (cause) {
      setError(t("connectDevices.actionFailed", { message: messageOf(cause) }));
      // A failed compound action can still have removed one forwarding route.
      try {
        await refresh();
      } catch {
        /* Keep the last known state until the user retries. */
      }
    } finally {
      setBusy(false);
    }
  };
  const enable = (method: "direct" | "https") => {
    void run(async () => {
      if (method === "direct") {
        const { changed } = await accessTokenApi.lan(true);
        if (changed) restart.start(true);
        else await refresh();
      } else {
        const result = await accessTokenApi.serve(true);
        if (result.error !== undefined) throw new Error(result.error);
        await refresh();
      }
    });
  };
  const stop = async () => {
    let data = await refresh();
    if (data.relay?.enabled) {
      await accessTokenApi.relay(false);
      data = await refresh();
    }
    const removed = new Set<string>();
    // Several HTTPS ports can forward here. Each API call rechecks ownership and removes one root.
    while (data.tailscale.status === "serving") {
      if (removed.has(data.tailscale.url) || removed.size >= 16)
        throw new Error(t("connectDevices.stopIncomplete"));
      removed.add(data.tailscale.url);
      const result = await accessTokenApi.serve(false);
      if (result.error !== undefined) throw new Error(result.error);
      data = await refresh();
    }
    if (data.tailscale.status === "error") throw new Error(data.tailscale.message);
    if (data.background?.lan) {
      const { changed } = await accessTokenApi.lan(false);
      if (changed) restart.start(false);
      else await refresh();
    }
    setConfirming(null);
  };

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

  const { data } = view;
  const { secret, lastUsedAt, networkUrls, tailscale, background } = data;
  const active = networkUrls.length > 0 || background?.lan === true;
  const canStop =
    background?.lan === true || tailscale.status === "serving" || data.relay?.enabled === true;
  const unmanaged = networkUrls.some(
    (entry) =>
      entry.kind === "public" ||
      (background === undefined && ["lan", "tailscale", "virtual"].includes(entry.kind)),
  );
  const used = lastUsedAt === null ? undefined : relativeTime(lastUsedAt, Date.now());
  const shownError = error ?? restart.error;
  return (
    <div className={css.page} data-connect-devices>
      <header className={css.header}>
        <div>
          <h2 className={css.title}>{t("connectDevices.title")}</h2>
          <p className={css.description}>{t("connectDevices.subtitle")}</p>
        </div>
        <span className={css.status} data-active={active && restart.target === null}>
          {t(
            restart.target !== null
              ? "connectDevices.preparing"
              : active
                ? "connectDevices.accessEnabled"
                : "connectDevices.localAccess",
          )}
        </span>
      </header>
      <ConnectionCard
        data={data}
        busy={working}
        restarting={restart.target !== null}
        onEnable={enable}
        onRelay={(enabled, registration) => {
          void run(async () => {
            await accessTokenApi.relay(enabled, registration);
            await refresh();
          });
        }}
        onRefresh={() => {
          void run(async () => {
            await refresh();
          });
        }}
        t={t}
      />
      {confirming === null && shownError != null && (
        <p role="alert" className={css.error}>
          {shownError}
        </p>
      )}
      <section className={css.manage}>
        <div className={css.manageRow}>
          <div className={css.manageText}>
            <span className={css.manageTitle}>{t("connectDevices.tokenTitle")}</span>
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
          </div>
          <div className={css.manageActions}>
            <Button
              variant="outline"
              disabled={working}
              onClick={() => {
                setError(null);
                void navigator.clipboard.writeText(secret).then(
                  () => setTokenCopied(true),
                  () => setError(t("connectDevices.copyFailed")),
                );
              }}
            >
              {t(tokenCopied ? "connectDevices.copied" : "connectDevices.copyToken")}
            </Button>
            <Button
              variant="outline"
              disabled={working}
              onClick={() => {
                setError(null);
                setConfirming("regenerate");
              }}
            >
              {t("connectDevices.regenerate")}
            </Button>
          </div>
        </div>
        {background !== undefined && (
          <AutostartControl state={background} disabled={working} restored={restored} t={t} />
        )}
      </section>
      {canStop && (
        <div className={`${css.manageRow} ${css.stopRow}`}>
          <div className={css.manageText}>
            <span className={css.manageTitle}>{t("connectDevices.stopTitleShort")}</span>
            <span className={css.meta}>{t("connectDevices.stopHint")}</span>
          </div>
          <div className={css.manageActions}>
            <Button
              variant="outline"
              className={css.dangerOutline}
              disabled={working}
              onClick={() => {
                setError(null);
                setConfirming("stop");
              }}
            >
              {t("connectDevices.stop")}
            </Button>
          </div>
        </div>
      )}
      <details className={css.other} data-remote-options>
        <summary>{t("connectDevices.help")}</summary>
        <div className={css.remoteList}>
          <p className={css.notice}>{t("connectDevices.keepAwake")}</p>
          <div className={css.routeText}>
            <span className={css.routeTitle}>Tailscale</span>
            <span className={css.meta}>{t("connectDevices.remote.tailscale")}</span>
            <a
              className={css.link}
              href="https://tailscale.com/download"
              target="_blank"
              rel="noreferrer"
            >
              {t("connectDevices.remote.tailscaleLink")}
            </a>
          </div>
          <div className={css.routeText}>
            <span className={css.routeTitle}>{t("connectDevices.remote.tunnelTitle")}</span>
            <span className={css.meta}>{t("connectDevices.remote.tunnel")}</span>
            <a
              className={css.link}
              href="https://github.com/BytePioneer-AI/codex-host/blob/main/docs/product/web-remote-access.md"
              target="_blank"
              rel="noreferrer"
            >
              {t("connectDevices.remote.tunnelLink")}
            </a>
          </div>
        </div>
      </details>
      {confirming !== null && (
        <Confirm
          t={t}
          title={t(
            confirming === "stop" ? "connectDevices.stopTitle" : "connectDevices.regenerateTitle",
          )}
          description={
            confirming === "stop"
              ? `${t("connectDevices.stopDescription")}${unmanaged ? ` ${t("connectDevices.stopUnmanaged")}` : ""}`
              : t("connectDevices.regenerateDescription")
          }
          confirmLabel={t(
            confirming === "stop"
              ? "connectDevices.stopConfirm"
              : "connectDevices.regenerateConfirm",
          )}
          busy={working}
          error={error}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            void run(
              confirming === "stop"
                ? stop
                : async () => {
                    restored(await accessTokenApi.regenerate());
                    setConfirming(null);
                  },
            );
          }}
        />
      )}
    </div>
  );
}
