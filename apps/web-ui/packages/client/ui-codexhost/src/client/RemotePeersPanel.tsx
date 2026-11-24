/** Remote peer host management: pair, test, reconnect, edit, and remove remote CodexHost peers. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  Switch,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { RemotePeerState, RemotePeerSummary } from "@codexhost/shared-contracts";
import { remotePeersApi } from "./api.ts";
import {
  dispatchOpenAddRemoteWorkspace,
  dispatchRemotePeersUpdated,
  REMOTE_PEERS_UPDATED_EVENT,
} from "./remote-peers-events.ts";
import { RemoteHostIcon, UnlockIcon } from "./RemoteHostIcon.tsx";
import {
  AddPeerModal,
  EditPeerModal,
  RemovePeerModal,
  TRANSPORT_LABEL,
  errorMessageOf as messageOf,
  type RemotePeersTranslate as Translate,
} from "./RemotePeerModals.tsx";
import css from "./RemotePeersPanel.module.css";

type ListView =
  | { kind: "loading" }
  | { kind: "ready"; peers: RemotePeerSummary[] }
  | { kind: "failed"; message: string };

type LoadMode = "initial" | "background" | "silent";

// Distinguish "never fetched" (`undefined`) from "fetched and empty" (`[]`).
let cachedPeers: RemotePeerSummary[] | undefined;
let inFlightPeers: Promise<RemotePeerSummary[]> | undefined;
let cacheGeneration = 0;

function fetchRemotePeers(force = false): Promise<RemotePeerSummary[]> {
  if (!force && inFlightPeers !== undefined) return inFlightPeers;
  if (force) {
    cacheGeneration += 1;
  }
  const generation = cacheGeneration;
  const request = remotePeersApi
    .list()
    .then((result) => {
      if (generation === cacheGeneration) {
        cachedPeers = result.peers;
      }
      return result.peers;
    })
    .finally(() => {
      if (inFlightPeers === request) {
        inFlightPeers = undefined;
      }
    });
  inFlightPeers = request;
  return request;
}

function updateCachedPeers(updater: (peers: RemotePeerSummary[]) => RemotePeerSummary[]): void {
  cacheGeneration += 1;
  inFlightPeers = undefined;
  if (cachedPeers !== undefined) {
    cachedPeers = updater(cachedPeers);
  }
}

export function prefetchRemotePeers(): void {
  void fetchRemotePeers().catch(() => undefined);
}

export function clearRemotePeersCache(): void {
  cacheGeneration += 1;
  cachedPeers = undefined;
  inFlightPeers = undefined;
}

const STATE_LABEL: Record<RemotePeerState, Parameters<Translate>[0]> = {
  connected: "remotePeers.state.connected",
  connecting: "remotePeers.state.connecting",
  "auth-error": "remotePeers.state.authError",
  offline: "remotePeers.state.offline",
  disabled: "remotePeers.state.disabled",
};

const CONNECTING_POLL_DELAYS_MS = [800, 1_200, 1_500, 2_000, 2_500, 3_000] as const;

function formatOriginDisplay(origin: string): string {
  try {
    const url = new URL(origin);
    const pathname = url.pathname && url.pathname !== "/" ? url.pathname.replace(/\/+$/u, "") : "";
    return `${url.host}${pathname}`;
  } catch {
    return origin.replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
  }
}

export function RemotePeersPanel({ t }: { t: Translate }): ReactNode {
  const [view, setView] = useState<ListView>(() =>
    cachedPeers !== undefined ? { kind: "ready", peers: cachedPeers } : { kind: "loading" },
  );
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [openMenuPeerId, setOpenMenuPeerId] = useState<string | null>(null);

  const [reconnectingIds, setReconnectingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingPeer, setEditingPeer] = useState<RemotePeerSummary | null>(null);
  const [removingPeer, setRemovingPeer] = useState<RemotePeerSummary | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  const loadPeers = useCallback(
    async (mode: LoadMode = "initial", force = false): Promise<void> => {
      const seq = ++loadSeqRef.current;
      const showSpinner = mode === "background";
      if (showSpinner) setRefreshing(true);
      try {
        const peers = await fetchRemotePeers(force);
        if (seq !== loadSeqRef.current) return;
        setView({ kind: "ready", peers });
      } catch (cause) {
        if (seq !== loadSeqRef.current) return;
        if (mode === "initial") {
          setView({ kind: "failed", message: messageOf(cause) });
        }
      } finally {
        if (showSpinner && seq === loadSeqRef.current) setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (cachedPeers !== undefined) {
      setView({ kind: "ready", peers: cachedPeers });
      void loadPeers("silent");
    } else {
      void loadPeers("initial");
    }
    return () => {
      loadSeqRef.current += 1;
    };
  }, [loadPeers]);

  useEffect(() => {
    const refresh = () => {
      void loadPeers("background", true);
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

  const connectingKey =
    view.kind === "ready"
      ? view.peers
          .filter((peer) => peer.enabled && peer.state === "connecting")
          .map((peer) => peer.peerId)
          .sort()
          .join(",")
      : "";

  useEffect(() => {
    if (connectingKey === "") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (attempt: number): void => {
      const delay = CONNECTING_POLL_DELAYS_MS[attempt];
      if (delay === undefined) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        void loadPeers("silent", true).then(() => {
          if (!cancelled) poll(attempt + 1);
        });
      }, delay);
    };
    poll(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connectingKey, loadPeers]);

  const handleToggleEnabled = async (peer: RemotePeerSummary, enabled: boolean): Promise<void> => {
    setActionError(null);
    setTogglingIds((prev) => new Set(prev).add(peer.peerId));
    try {
      const { peer: updated } = await remotePeersApi.update({
        peerId: peer.peerId,
        enabled,
      });
      const replacePeer = (peers: RemotePeerSummary[]): RemotePeerSummary[] =>
        peers.map((item) => (item.peerId === updated.peerId ? updated : item));
      updateCachedPeers(replacePeer);
      setView((current) =>
        current.kind === "ready" ? { kind: "ready", peers: replacePeer(current.peers) } : current,
      );
      dispatchRemotePeersUpdated();
    } catch (cause) {
      setActionError(t("remotePeers.actionFailed", { message: messageOf(cause) }));
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(peer.peerId);
        return next;
      });
    }
  };

  const handleReconnect = async (peer: RemotePeerSummary): Promise<void> => {
    setActionError(null);
    setReconnectingIds((prev) => new Set(prev).add(peer.peerId));
    try {
      const { peer: updated } = await remotePeersApi.reconnect(peer.peerId);
      const replacePeer = (peers: RemotePeerSummary[]): RemotePeerSummary[] =>
        peers.map((item) => (item.peerId === updated.peerId ? updated : item));
      updateCachedPeers(replacePeer);
      setView((current) =>
        current.kind === "ready" ? { kind: "ready", peers: replacePeer(current.peers) } : current,
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
    const removedPeerId = removingPeer.peerId;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await remotePeersApi.remove(removedPeerId);
      const filterRemoved = (peers: RemotePeerSummary[]): RemotePeerSummary[] =>
        peers.filter((item) => item.peerId !== removedPeerId);
      updateCachedPeers(filterRemoved);
      setView((current) =>
        current.kind === "ready" ? { kind: "ready", peers: filterRemoved(current.peers) } : current,
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
              onClick={() => void loadPeers("background", true)}
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
          <p className={css.loadingState}>{t("remotePeers.loading")}</p>
        </div>
      ) : view.kind === "failed" ? (
        <div className={css.errorRow} role="alert">
          <p className={css.error}>{t("remotePeers.loadFailed", { message: view.message })}</p>
          <Button variant="outline" size="sm" onClick={() => void loadPeers("initial")}>
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
            const toggling = togglingIds.has(peer.peerId);
            const connected = peer.enabled && peer.state === "connected";
            const menuOpen = openMenuPeerId === peer.peerId;
            const toggleLabel = t(
              peer.enabled ? "remotePeers.action.disable" : "remotePeers.action.enable",
              { name: peer.name },
            );
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
                          <RemoteHostIcon size={14} />
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
                    <Menu
                      open={menuOpen}
                      onClose={() => setOpenMenuPeerId(null)}
                      portal
                      align="end"
                      autoFocus
                      items={[
                        {
                          id: "add-workspace",
                          label: t("remotePeers.action.addWorkspace"),
                          icon: <IconPlusOutlineRegular size={14} />,
                          disabled: !connected || toggling,
                        },
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
                          disabled: reconnecting || toggling || !peer.enabled,
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
                        if (id === "add-workspace") {
                          dispatchOpenAddRemoteWorkspace(peer.hostId);
                        } else if (id === "reconnect") {
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
                    <Switch
                      checked={peer.enabled}
                      disabled={toggling}
                      label={toggleLabel}
                      title={toggleLabel}
                      className={css.peerSwitch}
                      onChange={(next) => void handleToggleEnabled(peer, next)}
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
        <AddPeerModal
          t={t}
          onClose={() => setAddOpen(false)}
          onAdded={() => loadPeers("background", true)}
        />
      )}

      {editingPeer !== null && (
        <EditPeerModal
          peer={editingPeer}
          t={t}
          onClose={() => setEditingPeer(null)}
          onSaved={(updated) => {
            const replacePeer = (peers: RemotePeerSummary[]): RemotePeerSummary[] =>
              peers.map((item) => (item.peerId === updated.peerId ? updated : item));
            updateCachedPeers(replacePeer);
            setView((current) =>
              current.kind === "ready"
                ? { kind: "ready", peers: replacePeer(current.peers) }
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
