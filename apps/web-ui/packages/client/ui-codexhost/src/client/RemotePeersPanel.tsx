/** Remote peer host management: pair, test, reconnect, edit, and remove remote CodexHost peers. */
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  IconCheckCircleOutlineRegular,
  IconEditOutlineRegular,
  IconGlobeOutlineRegular,
  IconLoadingOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningTriangleOutlineRegular,
  Modal,
  Switch,
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
      className={css.modal}
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("connectDevices.cancel")}
          </Button>
          <Button
            variant="primary"
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
            <span className={css.label}>{t("remotePeers.field.enabled")}</span>
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
          <div className={css.credentialsHead}>
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

  const [mode, setMode] = useState<AddMode>("link");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [testing, setTesting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [testResult, setTestResult] = useState<RemotePeerTestResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [reconnectingIds, setReconnectingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingPeer, setEditingPeer] = useState<RemotePeerSummary | null>(null);
  const [removingPeer, setRemovingPeer] = useState<RemotePeerSummary | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const linkId = useId();
  const originId = useId();
  const tokenId = useId();
  const nameId = useId();

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

  const handleAdd = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const built = buildCredentials();
    if (!built.ok) {
      setFormError(built.message);
      return;
    }
    setAdding(true);
    setFormError(null);
    try {
      await remotePeersApi.add(built.addParams);
      setConnectionUrl("");
      setOrigin("");
      setToken("");
      setDisplayName("");
      setTestResult(null);
      dispatchRemotePeersUpdated();
      await loadPeers(true);
    } catch (cause) {
      setFormError(t("remotePeers.actionFailed", { message: messageOf(cause) }));
    } finally {
      setAdding(false);
    }
  };

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

  const formBusy = testing || adding;

  return (
    <div className={css.panel} data-remote-peers-panel>
      <header className={css.header}>
        <div className={css.headerText}>
          <h2 className={css.title}>{t("remotePeers.title")}</h2>
          <p className={css.description}>{t("remotePeers.subtitle")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          icon={
            refreshing ? (
              <span className={css.spinner}>
                <IconLoadingOutlineRegular size={14} />
              </span>
            ) : (
              <IconRefreshOutlineRegular size={14} />
            )
          }
          onClick={() => void loadPeers(true)}
        >
          {t("remotePeers.refresh")}
        </Button>
      </header>

      <section className={css.addCard} aria-label={t("remotePeers.addTitle")}>
        <div className={css.addHead}>
          <div className={css.addHeadText}>
            <h3 className={css.cardHeading}>{t("remotePeers.addTitle")}</h3>
            <p className={css.hint}>{t("remotePeers.addHint")}</p>
          </div>
          <button
            type="button"
            className={css.modeToggle}
            disabled={formBusy}
            onClick={() => {
              setMode((prev) => (prev === "link" ? "manual" : "link"));
              setFormError(null);
              setTestResult(null);
            }}
          >
            {t(mode === "link" ? "remotePeers.switchToManual" : "remotePeers.switchToLink")}
          </button>
        </div>

        <form className={css.form} onSubmit={(event) => void handleAdd(event)}>
          {mode === "link" ? (
            <div className={css.field}>
              <label htmlFor={linkId} className={css.label}>
                {t("remotePeers.field.link")}
              </label>
              <input
                id={linkId}
                className={css.input}
                value={connectionUrl}
                disabled={formBusy}
                placeholder={t("remotePeers.placeholder.link")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setConnectionUrl(event.target.value);
                  setFormError(null);
                  setTestResult(null);
                }}
              />
            </div>
          ) : (
            <div className={css.manualGrid}>
              <div className={css.field}>
                <label htmlFor={originId} className={css.label}>
                  {t("remotePeers.field.origin")}
                </label>
                <input
                  id={originId}
                  className={css.input}
                  value={origin}
                  disabled={formBusy}
                  placeholder={t("remotePeers.placeholder.origin")}
                  autoComplete="off"
                  spellCheck={false}
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
            </div>
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

          {testResult !== null && (
            <div
              className={css.testResult}
              data-ok={testResult.ok}
              role={testResult.ok ? "status" : "alert"}
            >
              {testResult.ok ? (
                <>
                  <IconCheckCircleOutlineRegular size={16} className={css.testOkIcon} />
                  <div className={css.testResultBody}>
                    <span className={css.testResultTitle}>
                      {t("remotePeers.testSuccess")}
                      {testResult.latencyMs !== undefined
                        ? ` · ${t("remotePeers.latencyMs", { ms: testResult.latencyMs })}`
                        : ""}
                    </span>
                    <span className={css.testResultMeta}>
                      {[
                        testResult.hostname,
                        testResult.platform,
                        testResult.projectCount !== undefined
                          ? t("remotePeers.projectCount", { count: testResult.projectCount })
                          : undefined,
                        testResult.transportKind !== undefined
                          ? t(TRANSPORT_LABEL[testResult.transportKind])
                          : undefined,
                        testResult.encrypted === false
                          ? t("remotePeers.plainHttpBadge")
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <IconWarningTriangleOutlineRegular size={16} className={css.testErrorIcon} />
                  <div className={css.testResultBody}>
                    <span className={css.testResultTitle}>{t("remotePeers.testFailed")}</span>
                    {testResult.error !== undefined && testResult.error !== "" && (
                      <span className={css.testResultMeta}>{testResult.error}</span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {formError !== null && (
            <p className={css.error} role="alert">
              {formError}
            </p>
          )}

          <div className={css.formActions}>
            <Button
              variant="outline"
              disabled={formBusy}
              aria-busy={testing}
              onClick={() => void handleTest()}
            >
              {t(testing ? "remotePeers.testing" : "remotePeers.testConnection")}
            </Button>
            <Button type="submit" variant="primary" disabled={formBusy} aria-busy={adding}>
              {t(adding ? "remotePeers.adding" : "remotePeers.add")}
            </Button>
          </div>
        </form>
      </section>

      {actionError !== null && (
        <p className={css.error} role="alert">
          {actionError}
        </p>
      )}

      <section className={css.listSection} aria-label={t("remotePeers.listTitle")}>
        <div className={css.listHead}>
          <h3 className={css.cardHeading}>
            {view.kind === "ready"
              ? t("remotePeers.listTitleCount", { count: view.peers.length })
              : t("remotePeers.listTitle")}
          </h3>
        </div>

        {view.kind === "loading" ? (
          <p className={css.hint}>{t("remotePeers.loading")}</p>
        ) : view.kind === "failed" ? (
          <div className={css.errorBox} role="alert">
            <p className={css.error}>{t("remotePeers.loadFailed", { message: view.message })}</p>
            <Button variant="outline" size="sm" onClick={() => void loadPeers(false)}>
              {t("remotePeers.retry")}
            </Button>
          </div>
        ) : view.peers.length === 0 ? (
          <div className={css.emptyCard}>
            <IconGlobeOutlineRegular size={24} className={css.emptyIcon} />
            <p className={css.emptyTitle}>{t("remotePeers.emptyTitle")}</p>
            <p className={css.emptyDescription}>{t("remotePeers.emptyDescription")}</p>
          </div>
        ) : (
          <div className={css.peerList}>
            {view.peers.map((peer) => {
              const reconnecting = reconnectingIds.has(peer.peerId);
              const connected = peer.enabled && peer.state === "connected";
              const metaItems = [
                peer.latencyMs !== undefined
                  ? t("remotePeers.latencyMs", { ms: peer.latencyMs })
                  : undefined,
                t("remotePeers.projectCount", { count: peer.projectCount }),
                peer.hostname,
                peer.platform,
                peer.version ? `v${peer.version}` : undefined,
              ].filter(Boolean);

              return (
                <article
                  key={peer.peerId}
                  className={css.peerCard}
                  data-peer-id={peer.peerId}
                  data-peer-state={peer.state}
                >
                  <div className={css.peerTop}>
                    <div className={css.peerIdentity}>
                      <div className={css.peerNameRow}>
                        <span className={css.peerName}>{peer.name}</span>
                        <span className={css.stateBadge} data-state={peer.state}>
                          <span className={css.stateDot} aria-hidden="true" />
                          <span>{t(STATE_LABEL[peer.state])}</span>
                        </span>
                        <span className={css.transportBadge}>
                          {t(TRANSPORT_LABEL[peer.transportKind])}
                        </span>
                        {!peer.encrypted && (
                          <span
                            className={css.insecureBadge}
                            title={t("remotePeers.plainHttpTooltip")}
                          >
                            {t("remotePeers.plainHttpBadge")}
                          </span>
                        )}
                      </div>
                      <span className={css.peerOrigin}>{peer.origin}</span>
                      {metaItems.length > 0 && (
                        <span className={css.peerMeta}>{metaItems.join(" · ")}</span>
                      )}
                    </div>
                  </div>

                  {peer.lastError !== undefined && peer.lastError !== "" && (
                    <div className={css.peerError} role="alert">
                      <IconWarningTriangleOutlineRegular size={14} className={css.peerErrorIcon} />
                      <span>{peer.lastError}</span>
                    </div>
                  )}

                  <div className={css.peerActions}>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!connected}
                      icon={<IconPlusOutlineRegular size={14} />}
                      onClick={() => dispatchOpenAddRemoteWorkspace(peer.hostId)}
                    >
                      {t("remotePeers.action.addWorkspace")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={reconnecting || !peer.enabled}
                      aria-busy={reconnecting}
                      icon={
                        reconnecting ? (
                          <span className={css.spinner}>
                            <IconLoadingOutlineRegular size={14} />
                          </span>
                        ) : (
                          <IconRefreshOutlineRegular size={14} />
                        )
                      }
                      onClick={() => void handleReconnect(peer)}
                    >
                      {t(
                        reconnecting
                          ? "remotePeers.action.reconnecting"
                          : "remotePeers.action.reconnect",
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      icon={<IconEditOutlineRegular size={14} />}
                      onClick={() => {
                        setActionError(null);
                        setEditingPeer(peer);
                      }}
                    >
                      {t("remotePeers.action.edit")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className={css.dangerOutline}
                      icon={<IconTrashOutlineRegular size={14} />}
                      onClick={() => {
                        setRemoveError(null);
                        setRemovingPeer(peer);
                      }}
                    >
                      {t("remotePeers.action.remove")}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

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
