/** Remote peer host management: pair, test, reconnect, edit, and remove remote CodexHost peers. */
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconGlobeOutlineRegular,
  IconLoadingOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  Menu,
  Modal,
  Switch,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type {
  RemotePeerAddParams,
  RemotePeerState,
  RemotePeerSummary,
  RemotePeerTestParams,
  RemotePeerTestResult,
  RemotePeerTransportKind,
  RemotePeerUpdateParams,
} from "@codexhost/shared-contracts";
import { remotePeersApi } from "./api.ts";
import {
  dispatchOpenAddRemoteWorkspace,
  dispatchRemotePeersUpdated,
  REMOTE_PEERS_UPDATED_EVENT,
} from "./remote-peers-events.ts";
import css from "./RemotePeersPanel.module.css";

type Translate = PropsLocale<"codexhostImport">["t"];
type AddMode = "link" | "manual";

type ListView =
  | { kind: "loading" }
  | { kind: "ready"; peers: RemotePeerSummary[] }
  | { kind: "failed"; message: string };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const STATE_LABEL: Record<RemotePeerState, Parameters<Translate>[0]> = {
  connected: "remotePeers.state.connected",
  connecting: "remotePeers.state.connecting",
  "auth-error": "remotePeers.state.authError",
  offline: "remotePeers.state.offline",
  disabled: "remotePeers.state.disabled",
};

const TRANSPORT_LABEL: Record<RemotePeerTransportKind, Parameters<Translate>[0]> = {
  relay: "remotePeers.transport.relay",
  tailscale: "remotePeers.transport.tailscale",
  lan: "remotePeers.transport.lan",
  custom: "remotePeers.transport.custom",
};

function formatOriginDisplay(origin: string): string {
  try {
    const url = new URL(origin);
    const pathname = url.pathname && url.pathname !== "/" ? url.pathname.replace(/\/+$/u, "") : "";
    return `${url.host}${pathname}`;
  } catch {
    return origin.replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
  }
}

function UnlockIcon(): ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="3.25"
        y="7.25"
        width="9.5"
        height="6.5"
        rx="1.75"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="M5.5 7.25V5.25a2.5 2.5 0 0 1 4.85-.85"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AddPeerModal({
  onClose,
  onAdded,
  t,
}: {
  onClose: () => void;
  onAdded: () => Promise<void>;
  t: Translate;
}): ReactNode {
  const [mode, setMode] = useState<AddMode>("link");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [testing, setTesting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [testResult, setTestResult] = useState<RemotePeerTestResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const linkId = useId();
  const originId = useId();
  const tokenId = useId();
  const nameId = useId();

  const formBusy = testing || adding;

  const buildCredentials = ():
    | { ok: true; testParams: RemotePeerTestParams; addParams: RemotePeerAddParams }
    | { ok: false; message: string } => {
    const trimmedName = displayName.trim();
    if (mode === "link") {
      const trimmedUrl = connectionUrl.trim();
      if (!trimmedUrl) {
        return { ok: false, message: t("remotePeers.error.linkRequired") };
      }
      return {
        ok: true,
        testParams: { connectionUrl: trimmedUrl },
        addParams: {
          connectionUrl: trimmedUrl,
          ...(trimmedName ? { name: trimmedName } : {}),
        },
      };
    }
    const trimmedOrigin = origin.trim();
    const trimmedToken = token.trim();
    if (!trimmedOrigin) {
      return { ok: false, message: t("remotePeers.error.originRequired") };
    }
    if (!trimmedToken) {
      return { ok: false, message: t("remotePeers.error.tokenRequired") };
    }
    return {
      ok: true,
      testParams: { origin: trimmedOrigin, token: trimmedToken },
      addParams: {
        origin: trimmedOrigin,
        token: trimmedToken,
        ...(trimmedName ? { name: trimmedName } : {}),
      },
    };
  };

  const handleTest = async (): Promise<void> => {
    const built = buildCredentials();
    if (!built.ok) {
      setFormError(built.message);
      setTestResult(null);
      return;
    }
    setTesting(true);
    setFormError(null);
    setTestResult(null);
    try {
      const result = await remotePeersApi.test(built.testParams);
      setTestResult(result);
    } catch (cause) {
      setTestResult({ ok: false, error: messageOf(cause) });
    } finally {
      setTesting(false);
    }
  };

  const handleAdd = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const built = buildCredentials();
    if (!built.ok) {
      setFormError(built.message);
      return;
    }
    setAdding(true);
    setFormError(null);
    try {
      await remotePeersApi.add(built.addParams);
      dispatchRemotePeersUpdated();
      await onAdded();
      onClose();
    } catch (cause) {
      setFormError(t("remotePeers.actionFailed", { message: messageOf(cause) }));
    } finally {
      setAdding(false);
    }
  };

  const testSummary =
    testResult !== null && testResult.ok
      ? [
          t("remotePeers.testSuccess"),
          testResult.latencyMs !== undefined
            ? t("remotePeers.latencyMs", { ms: testResult.latencyMs })
            : undefined,
          testResult.projectCount !== undefined
            ? t("remotePeers.projectCount", { count: testResult.projectCount })
            : undefined,
          testResult.transportKind !== undefined
            ? t(TRANSPORT_LABEL[testResult.transportKind])
            : undefined,
          testResult.hostname,
        ]
          .filter(Boolean)
          .join(" · ")
      : testResult !== null
        ? [t("remotePeers.testFailed"), testResult.error].filter(Boolean).join(" · ")
        : null;

  return (
    <Modal
      open
      onClose={() => {
        if (!formBusy) onClose();
      }}
      title={t("remotePeers.addTitle")}
      closeLabel={t("connectDevices.close")}
      className={css.addModal}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={formBusy}
            aria-busy={testing}
            onClick={() => void handleTest()}
          >
            {t(testing ? "remotePeers.testing" : "remotePeers.testConnection")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={formBusy}
            aria-busy={adding}
            onClick={() => void handleAdd()}
          >
            {t(adding ? "remotePeers.adding" : "remotePeers.add")}
          </Button>
        </>
      }
    >
      <form className={css.modalForm} onSubmit={(event) => void handleAdd(event)}>
        {mode === "link" ? (
          <div className={css.field}>
            <div className={css.fieldHead}>
              <label htmlFor={linkId} className={css.label}>
                {t("remotePeers.field.link")}
              </label>
              <button
                type="button"
                className={css.modeToggle}
                disabled={formBusy}
                onClick={() => {
                  setMode("manual");
                  setFormError(null);
                  setTestResult(null);
                }}
              >
                {t("remotePeers.switchToManual")}
              </button>
            </div>
            <input
              id={linkId}
              className={css.input}
              value={connectionUrl}
              disabled={formBusy}
              placeholder={t("remotePeers.placeholder.link")}
              autoComplete="off"
              spellCheck={false}
              data-modal-autofocus
              onChange={(event) => {
                setConnectionUrl(event.target.value);
                setFormError(null);
                setTestResult(null);
              }}
            />
          </div>
        ) : (
          <>
            <div className={css.field}>
              <div className={css.fieldHead}>
                <label htmlFor={originId} className={css.label}>
                  {t("remotePeers.field.origin")}
                </label>
                <button
                  type="button"
                  className={css.modeToggle}
                  disabled={formBusy}
                  onClick={() => {
                    setMode("link");
                    setFormError(null);
                    setTestResult(null);
                  }}
                >
                  {t("remotePeers.switchToLink")}
                </button>
              </div>
              <input
                id={originId}
                className={css.input}
                value={origin}
                disabled={formBusy}
                placeholder={t("remotePeers.placeholder.origin")}
                autoComplete="off"
                spellCheck={false}
                data-modal-autofocus
                onChange={(event) => {
                  setOrigin(event.target.value);
                  setFormError(null);
                  setTestResult(null);
                }}
              />
            </div>
            <div className={css.field}>
              <label htmlFor={tokenId} className={css.label}>
                {t("remotePeers.field.token")}
              </label>
              <input
                id={tokenId}
                type="password"
                className={css.input}
                value={token}
                disabled={formBusy}
                placeholder={t("remotePeers.placeholder.token")}
                autoComplete="new-password"
                onChange={(event) => {
                  setToken(event.target.value);
                  setFormError(null);
                  setTestResult(null);
                }}
              />
            </div>
          </>
        )}

        <div className={css.field}>
          <label htmlFor={nameId} className={css.label}>
            {t("remotePeers.field.nameOptional")}
          </label>
          <input
            id={nameId}
            className={css.input}
            value={displayName}
            disabled={formBusy}
            maxLength={120}
            placeholder={t("remotePeers.placeholder.name")}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        {testResult !== null && testSummary !== null && (
          <div
            className={css.testInline}
            data-ok={testResult.ok}
            role={testResult.ok ? "status" : "alert"}
          >
            {testResult.ok ? (
              <svg
                width={13}
                height={13}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={css.testCheckIcon}
                aria-hidden="true"
              >
                <path d="M3.5 8.5 6.5 11.5 12.5 5" />
              </svg>
            ) : (
              <span className={css.testDot} aria-hidden="true" />
            )}
            <span className={css.testInlineText} title={testSummary}>
              {testSummary}
            </span>
          </div>
        )}

        {formError !== null && (
          <p className={css.error} role="alert">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}

function EditPeerModal({
  peer,
  onClose,
  onSaved,
  t,
}: {
  peer: RemotePeerSummary;
  onClose: () => void;
  onSaved: (updated: RemotePeerSummary) => void;
  t: Translate;
}): ReactNode {
  const [name, setName] = useState(peer.name);
  const [enabled, setEnabled] = useState(peer.enabled);
  const [mode, setMode] = useState<AddMode>("link");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [origin, setOrigin] = useState(peer.origin);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const linkId = useId();
  const originId = useId();
  const tokenId = useId();

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("remotePeers.error.nameRequired"));
      return;
    }
    const payload: RemotePeerUpdateParams = {
      peerId: peer.peerId,
      name: trimmedName,
      enabled,
    };
    if (mode === "link") {
      const trimmedUrl = connectionUrl.trim();
      if (trimmedUrl) payload.connectionUrl = trimmedUrl;
    } else {
      const trimmedOrigin = origin.trim();
      const trimmedToken = token.trim();
      if (trimmedOrigin && trimmedOrigin !== peer.origin) payload.origin = trimmedOrigin;
      if (trimmedToken) payload.token = trimmedToken;
    }
    setSaving(true);
    setError(null);
    try {
      const { peer: updated } = await remotePeersApi.update(payload);
      dispatchRemotePeersUpdated();
      onSaved(updated);
    } catch (cause) {
      setError(t("remotePeers.actionFailed", { message: messageOf(cause) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title={t("remotePeers.editTitle", { name: peer.name })}
      closeLabel={t("connectDevices.close")}
      className={css.addModal}
      footer={
        <>
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
            {t("connectDevices.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving}
            aria-busy={saving}
            onClick={() => void submit()}
          >
            {t(saving ? "remotePeers.saving" : "remotePeers.save")}
          </Button>
        </>
      }
    >
      <form className={css.modalForm} onSubmit={(event) => void submit(event)}>
        <div className={css.field}>
          <label htmlFor={nameId} className={css.label}>
            {t("remotePeers.field.name")}
          </label>
          <input
            id={nameId}
            className={css.input}
            value={name}
            disabled={saving}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            data-modal-autofocus
          />
        </div>
        <div className={css.switchRow}>
          <div className={css.switchText}>
            <span className={css.switchTitle}>{t("remotePeers.field.enabled")}</span>
            <span className={css.hint}>{t("remotePeers.field.enabledHint")}</span>
          </div>
          <Switch
            checked={enabled}
            disabled={saving}
            label={t("remotePeers.field.enabled")}
            onChange={setEnabled}
          />
        </div>
        <div className={css.credentialsBox}>
          <div className={css.fieldHead}>
            <span className={css.label}>{t("remotePeers.editCredentialsTitle")}</span>
            <button
              type="button"
              className={css.modeToggle}
              disabled={saving}
              onClick={() => {
                setMode((prev) => (prev === "link" ? "manual" : "link"));
                setError(null);
              }}
            >
              {t(mode === "link" ? "remotePeers.switchToManual" : "remotePeers.switchToLink")}
            </button>
          </div>
          <p className={css.hint}>{t("remotePeers.editCredentialsHint")}</p>
          {mode === "link" ? (
            <div className={css.field}>
              <label htmlFor={linkId} className={css.label}>
                {t("remotePeers.field.linkOptional")}
              </label>
              <input
                id={linkId}
                className={css.input}
                value={connectionUrl}
                disabled={saving}
                placeholder={t("remotePeers.placeholder.link")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setConnectionUrl(event.target.value)}
              />
            </div>
          ) : (
            <>
              <div className={css.field}>
                <label htmlFor={originId} className={css.label}>
                  {t("remotePeers.field.origin")}
                </label>
                <input
                  id={originId}
                  className={css.input}
                  value={origin}
                  disabled={saving}
                  placeholder={t("remotePeers.placeholder.origin")}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setOrigin(event.target.value)}
                />
              </div>
              <div className={css.field}>
                <label htmlFor={tokenId} className={css.label}>
                  {t("remotePeers.field.tokenOptional")}
                </label>
                <input
                  id={tokenId}
                  type="password"
                  className={css.input}
                  value={token}
                  disabled={saving}
                  placeholder={t("remotePeers.placeholder.tokenKeep")}
                  autoComplete="new-password"
                  onChange={(event) => setToken(event.target.value)}
                />
              </div>
            </>
          )}
        </div>
        {error !== null && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function RemovePeerModal({
  peer,
  busy,
  error,
  onClose,
  onConfirm,
  t,
}: {
  peer: RemotePeerSummary;
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
      title={t("remotePeers.removeTitle", { name: peer.name })}
      description={t("remotePeers.removeDescription", { origin: peer.origin })}
      closeLabel={t("connectDevices.close")}
      className={css.confirm}
      footer={
        <>
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            {t("connectDevices.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className={css.dangerConfirm}
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {t(busy ? "remotePeers.removing" : "remotePeers.removeConfirm")}
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

export function RemotePeersPanel({ t }: { t: Translate }): ReactNode {
  const [view, setView] = useState<ListView>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [openMenuPeerId, setOpenMenuPeerId] = useState<string | null>(null);

  const [reconnectingIds, setReconnectingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingPeer, setEditingPeer] = useState<RemotePeerSummary | null>(null);
  const [removingPeer, setRemovingPeer] = useState<RemotePeerSummary | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadPeers = useCallback(async (background = false): Promise<void> => {
    if (background) setRefreshing(true);
    try {
      const result = await remotePeersApi.list();
      setView({ kind: "ready", peers: result.peers });
    } catch (cause) {
      if (!background) {
        setView({ kind: "failed", message: messageOf(cause) });
      }
    } finally {
      if (background) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadPeers(false);
  }, [loadPeers]);

  useEffect(() => {
    const refresh = () => {
      void loadPeers(true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener(REMOTE_PEERS_UPDATED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener(REMOTE_PEERS_UPDATED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadPeers]);

  const handleReconnect = async (peer: RemotePeerSummary): Promise<void> => {
    setActionError(null);
    setReconnectingIds((prev) => new Set(prev).add(peer.peerId));
    try {
      const { peer: updated } = await remotePeersApi.reconnect(peer.peerId);
      setView((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              peers: current.peers.map((item) => (item.peerId === updated.peerId ? updated : item)),
            }
          : current,
      );
      dispatchRemotePeersUpdated();
    } catch (cause) {
      setActionError(t("remotePeers.actionFailed", { message: messageOf(cause) }));
    } finally {
      setReconnectingIds((prev) => {
        const next = new Set(prev);
        next.delete(peer.peerId);
        return next;
      });
    }
  };

  const handleConfirmRemove = async (): Promise<void> => {
    if (removingPeer === null) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await remotePeersApi.remove(removingPeer.peerId);
      setView((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              peers: current.peers.filter((item) => item.peerId !== removingPeer.peerId),
            }
          : current,
      );
      setRemovingPeer(null);
      dispatchRemotePeersUpdated();
    } catch (cause) {
      setRemoveError(t("remotePeers.actionFailed", { message: messageOf(cause) }));
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <div className={css.panel} data-remote-peers-panel>
      <header className={css.header}>
        <div className={css.headerText}>
          <h2 className={css.title}>{t("remotePeers.title")}</h2>
          <p className={css.description}>{t("remotePeers.subtitle")}</p>
        </div>
        <div className={css.headerActions}>
          <Tooltip label={t("remotePeers.refresh")} side="bottom" delayMs={400}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t("remotePeers.refresh")}
              disabled={refreshing}
              onClick={() => void loadPeers(true)}
            >
              {refreshing ? (
                <span className={css.spinner}>
                  <IconLoadingOutlineRegular size={15} />
                </span>
              ) : (
                <IconRefreshOutlineRegular size={15} />
              )}
            </button>
          </Tooltip>
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlusOutlineRegular size={14} />}
            onClick={() => setAddOpen(true)}
          >
            {t("remotePeers.add")}
          </Button>
        </div>
      </header>

      {actionError !== null && (
        <p className={css.error} role="alert">
          {actionError}
        </p>
      )}

      {view.kind === "loading" ? (
        <div className={css.surface}>
          <p className={css.stateText}>{t("remotePeers.loading")}</p>
        </div>
      ) : view.kind === "failed" ? (
        <div className={css.errorRow} role="alert">
          <p className={css.error}>{t("remotePeers.loadFailed", { message: view.message })}</p>
          <Button variant="outline" size="sm" onClick={() => void loadPeers(false)}>
            {t("remotePeers.retry")}
          </Button>
        </div>
      ) : view.peers.length === 0 ? (
        <div className={css.surface}>
          <div className={css.emptyState}>
            <IconGlobeOutlineRegular size={22} className={css.emptyIcon} />
            <p className={css.emptyTitle}>{t("remotePeers.emptyTitle")}</p>
            <p className={css.emptyDescription}>{t("remotePeers.emptyDescription")}</p>
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlusOutlineRegular size={14} />}
              className={css.emptyAction}
              onClick={() => setAddOpen(true)}
            >
              {t("remotePeers.add")}
            </Button>
          </div>
        </div>
      ) : (
        <section className={css.surface} aria-label={t("remotePeers.listTitle")}>
          {view.peers.map((peer) => {
            const reconnecting = reconnectingIds.has(peer.peerId);
            const connected = peer.enabled && peer.state === "connected";
            const menuOpen = openMenuPeerId === peer.peerId;
            const showLastError =
              (peer.state === "offline" || peer.state === "auth-error") &&
              peer.lastError !== undefined &&
              peer.lastError !== "";
            const metaLine = [
              formatOriginDisplay(peer.origin),
              t("remotePeers.projectCount", { count: peer.projectCount }),
              peer.latencyMs !== undefined
                ? t("remotePeers.latencyMs", { ms: peer.latencyMs })
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <div
                key={peer.peerId}
                className={css.peerRow}
                data-peer-id={peer.peerId}
                data-peer-state={peer.state}
              >
                <div className={css.peerMain}>
                  <div className={css.peerIdentity}>
                    <div className={css.peerNameRow}>
                      {connected ? (
                        <span
                          className={css.hostIcon}
                          role="img"
                          aria-label={t(STATE_LABEL[peer.state])}
                          title={t(STATE_LABEL[peer.state])}
                        >
                          <svg
                            width={14}
                            height={14}
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.45"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <rect x="2" y="2.5" width="12" height="8.5" rx="1.75" />
                            <path d="M5.5 13.5h5M8 11v2.5" />
                          </svg>
                        </span>
                      ) : (
                        <span
                          className={css.statusDot}
                          data-state={peer.state}
                          role="img"
                          aria-label={t(STATE_LABEL[peer.state])}
                          title={t(STATE_LABEL[peer.state])}
                        />
                      )}
                      <span className={css.peerName}>{peer.name}</span>
                      <span className={css.transportWord}>
                        {t(TRANSPORT_LABEL[peer.transportKind])}
                      </span>
                      {!connected && (
                        <span className={css.stateText} data-state={peer.state}>
                          {t(STATE_LABEL[peer.state])}
                        </span>
                      )}
                    </div>
                    <div className={css.peerMetaRow}>
                      <span className={css.peerMeta} title={peer.origin}>
                        {metaLine}
                      </span>
                      {!peer.encrypted && (
                        <Tooltip label={t("remotePeers.plainHttpTooltip")} side="top" delayMs={250}>
                          <span
                            className={css.unlockIcon}
                            role="img"
                            aria-label={t("remotePeers.plainHttpTooltip")}
                          >
                            <UnlockIcon />
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </div>

                  <div className={css.peerActions}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={css.addDirBtn}
                      disabled={!connected}
                      onClick={() => dispatchOpenAddRemoteWorkspace(peer.hostId)}
                    >
                      {t("remotePeers.action.addWorkspace")}
                    </Button>
                    <Menu
                      open={menuOpen}
                      onClose={() => setOpenMenuPeerId(null)}
                      portal
                      align="end"
                      autoFocus
                      items={[
                        {
                          id: "reconnect",
                          label: t(
                            reconnecting
                              ? "remotePeers.action.reconnecting"
                              : "remotePeers.action.reconnect",
                          ),
                          icon: reconnecting ? (
                            <span className={css.spinner}>
                              <IconLoadingOutlineRegular size={14} />
                            </span>
                          ) : (
                            <IconRefreshOutlineRegular size={14} />
                          ),
                          disabled: reconnecting || !peer.enabled,
                        },
                        {
                          id: "edit",
                          label: t("remotePeers.action.edit"),
                          icon: <IconEditOutlineRegular size={14} />,
                        },
                        { type: "separator", id: "danger-sep" },
                        {
                          id: "remove",
                          label: t("remotePeers.action.remove"),
                          icon: <IconTrashOutlineRegular size={14} />,
                          danger: true,
                        },
                      ]}
                      onSelect={(id) => {
                        setOpenMenuPeerId(null);
                        if (id === "reconnect") {
                          void handleReconnect(peer);
                        } else if (id === "edit") {
                          setActionError(null);
                          setEditingPeer(peer);
                        } else if (id === "remove") {
                          setRemoveError(null);
                          setRemovingPeer(peer);
                        }
                      }}
                      anchor={
                        <button
                          type="button"
                          className={css.iconButton}
                          aria-label={t("remotePeers.action.moreActions")}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          onClick={() =>
                            setOpenMenuPeerId((current) =>
                              current === peer.peerId ? null : peer.peerId,
                            )
                          }
                        >
                          <IconEllipsisOutlineRegular size={16} />
                        </button>
                      }
                    />
                  </div>
                </div>

                {showLastError && (
                  <p className={css.peerErrorNote} role="alert" title={peer.lastError}>
                    {peer.lastError}
                  </p>
                )}
              </div>
            );
          })}
        </section>
      )}

      {addOpen && (
        <AddPeerModal t={t} onClose={() => setAddOpen(false)} onAdded={() => loadPeers(true)} />
      )}

      {editingPeer !== null && (
        <EditPeerModal
          peer={editingPeer}
          t={t}
          onClose={() => setEditingPeer(null)}
          onSaved={(updated) => {
            setView((current) =>
              current.kind === "ready"
                ? {
                    kind: "ready",
                    peers: current.peers.map((item) =>
                      item.peerId === updated.peerId ? updated : item,
                    ),
                  }
                : current,
            );
            setEditingPeer(null);
          }}
        />
      )}

      {removingPeer !== null && (
        <RemovePeerModal
          peer={removingPeer}
          busy={removeBusy}
          error={removeError}
          t={t}
          onClose={() => {
            setRemovingPeer(null);
            setRemoveError(null);
          }}
          onConfirm={() => void handleConfirmRemove()}
        />
      )}
    </div>
  );
}
