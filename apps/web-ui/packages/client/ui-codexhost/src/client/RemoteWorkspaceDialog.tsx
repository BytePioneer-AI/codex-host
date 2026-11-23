/** Modal remote directory browser for adding a workspace on a connected remote peer. */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconFolderCloseRegular,
  IconGlobeOutlineRegular,
  IconLoadingOutlineRegular,
  IconPlusOutlineRegular,
  Menu,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { RemotePeerListDirsResult, RemotePeerSummary } from "@codexhost/shared-contracts";
import { remotePeersApi } from "./api.ts";
import {
  dispatchOpenRemotePeersSettings,
  dispatchRemotePeersUpdated,
} from "./remote-peers-events.ts";
import css from "./RemoteWorkspaceDialog.module.css";

interface DialogState {
  readonly open: boolean;
  readonly initialHostId?: string;
  readonly openToken: number;
}

/** Lightweight store bridging `window` events and the `shell.overlay` dialog occupant. */
export class RemoteWorkspaceDialogController {
  private state: DialogState = { open: false, openToken: 0 };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): DialogState => this.state;

  open(hostId?: string): void {
    this.state = {
      open: true,
      ...(hostId === undefined ? {} : { initialHostId: hostId }),
      openToken: this.state.openToken + 1,
    };
    this.emit();
  }

  close(): void {
    if (!this.state.open) return;
    this.state = { open: false, openToken: this.state.openToken };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface RemoteWorkspaceDialogFace {
  controller: RemoteWorkspaceDialogController;
}

type Props = PropsRuntime<"shell.overlay"> &
  PropsLocale<"codexhostImport"> &
  RemoteWorkspaceDialogFace;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  if (!trimmed) return path;
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash === -1 ? trimmed : trimmed.slice(slash + 1) || trimmed;
}

export function RemoteWorkspaceDialog({ controller, t }: Props): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const [peersLoading, setPeersLoading] = useState(false);
  const [peersError, setPeersError] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<RemotePeerSummary[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [peerMenuOpen, setPeerMenuOpen] = useState(false);

  const [listing, setListing] = useState<RemotePeerListDirsResult | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [dirsLoading, setDirsLoading] = useState(false);
  const [dirsError, setDirsError] = useState<string | null>(null);

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createFolderBusy, setCreateFolderBusy] = useState(false);
  const [createFolderError, setCreateFolderError] = useState<string | null>(null);

  const [workspaceTitle, setWorkspaceTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const listRequestSeq = useRef(0);
  const pathInputId = useId();
  const titleInputId = useId();
  const newFolderInputId = useId();

  const selectedPeer = connectedPeers.find((peer) => peer.peerId === selectedPeerId) ?? null;

  const loadDirectory = useCallback(async (peerId: string, path?: string): Promise<void> => {
    const seq = ++listRequestSeq.current;
    setDirsLoading(true);
    setDirsError(null);
    try {
      const result = await remotePeersApi.listDirs(peerId, path);
      if (seq !== listRequestSeq.current) return;
      setListing(result);
      setPathDraft(result.path);
    } catch (cause) {
      if (seq !== listRequestSeq.current) return;
      setDirsError(messageOf(cause));
    } finally {
      if (seq === listRequestSeq.current) setDirsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!state.open) return;
    let cancelled = false;
    setPeersLoading(true);
    setPeersError(null);
    setPeerMenuOpen(false);
    setListing(null);
    setPathDraft("");
    setDirsError(null);
    setCreatingFolder(false);
    setNewFolderName("");
    setCreateFolderError(null);
    setWorkspaceTitle("");
    setSubmitError(null);

    void remotePeersApi
      .list()
      .then((result) => {
        if (cancelled) return;
        const available = result.peers.filter((peer) => peer.enabled && peer.state === "connected");
        setConnectedPeers(available);
        const preferred =
          state.initialHostId !== undefined
            ? available.find((peer) => peer.hostId === state.initialHostId)
            : undefined;
        const chosen = preferred ?? available[0] ?? null;
        setSelectedPeerId(chosen?.peerId ?? null);
        if (chosen !== null) {
          void loadDirectory(chosen.peerId);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setPeersError(messageOf(cause));
        setConnectedPeers([]);
        setSelectedPeerId(null);
      })
      .finally(() => {
        if (!cancelled) setPeersLoading(false);
      });

    return () => {
      cancelled = true;
      listRequestSeq.current += 1;
    };
  }, [state.open, state.openToken, state.initialHostId, loadDirectory]);

  if (!state.open) return null;

  const currentPath = listing?.path ?? "";
  const homeDir = listing?.homeDir ?? selectedPeer?.homeDir;
  const parentPath = listing?.parentPath ?? null;
  const busy = submitting || createFolderBusy;

  const handleSelectPeer = (peerId: string): void => {
    setPeerMenuOpen(false);
    if (peerId === selectedPeerId) return;
    setSelectedPeerId(peerId);
    setListing(null);
    setPathDraft("");
    setDirsError(null);
    setCreatingFolder(false);
    setNewFolderName("");
    setCreateFolderError(null);
    setSubmitError(null);
    void loadDirectory(peerId);
  };

  const handlePathSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (selectedPeer === null || dirsLoading) return;
    const target = pathDraft.trim();
    if (!target) return;
    void loadDirectory(selectedPeer.peerId, target);
  };

  const handleCreateFolder = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (selectedPeer === null || !currentPath) return;
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setCreateFolderError(t("remoteWorkspace.error.folderNameRequired"));
      return;
    }
    setCreateFolderBusy(true);
    setCreateFolderError(null);
    try {
      const created = await remotePeersApi.createDir(selectedPeer.peerId, currentPath, trimmed);
      setCreatingFolder(false);
      setNewFolderName("");
      await loadDirectory(selectedPeer.peerId, created.path);
    } catch (cause) {
      setCreateFolderError(messageOf(cause));
    } finally {
      setCreateFolderBusy(false);
    }
  };

  const handleAddWorkspace = async (): Promise<void> => {
    if (selectedPeer === null || !currentPath) return;
    setSubmitting(true);
    setSubmitError(null);
    const trimmedTitle = workspaceTitle.trim();
    try {
      await remotePeersApi.createWorkspace({
        peerId: selectedPeer.peerId,
        path: currentPath,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
      });
      dispatchRemotePeersUpdated();
      controller.close();
    } catch (cause) {
      setSubmitError(t("remoteWorkspace.error.createFailed", { message: messageOf(cause) }));
    } finally {
      setSubmitting(false);
    }
  };

  const close = (): void => {
    if (!submitting) controller.close();
  };

  return (
    <Modal
      open={state.open}
      onClose={close}
      title={t("remoteWorkspace.title")}
      closeLabel={t("connectDevices.close")}
      className={css.dialog}
      contentClassName={css.content}
      footer={
        selectedPeer !== null ? (
          <div className={css.footer}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || dirsLoading || !currentPath}
              icon={<IconPlusOutlineRegular size={14} />}
              onClick={() => {
                setCreatingFolder((prev) => !prev);
                setCreateFolderError(null);
                setNewFolderName("");
              }}
            >
              {t("remoteWorkspace.newFolder")}
            </Button>
            <div className={css.footerSpacer} />
            <Button variant="outline" disabled={submitting} onClick={close}>
              {t("connectDevices.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={submitting || dirsLoading || !currentPath}
              aria-busy={submitting}
              onClick={() => void handleAddWorkspace()}
            >
              {t(submitting ? "remoteWorkspace.adding" : "remoteWorkspace.addCurrent")}
            </Button>
          </div>
        ) : (
          <Button variant="outline" onClick={close}>
            {t("connectDevices.close")}
          </Button>
        )
      }
    >
      <div className={css.body}>
        {peersLoading ? (
          <div className={css.centerState}>
            <span className={css.spinner}>
              <IconLoadingOutlineRegular size={18} />
            </span>
            <span>{t("remoteWorkspace.loadingPeers")}</span>
          </div>
        ) : peersError !== null ? (
          <div className={css.emptyState} role="alert">
            <p className={css.error}>{peersError}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => controller.open(state.initialHostId)}
            >
              {t("remotePeers.retry")}
            </Button>
          </div>
        ) : connectedPeers.length === 0 ? (
          <div className={css.emptyState}>
            <IconGlobeOutlineRegular size={26} className={css.emptyIcon} />
            <p className={css.emptyTitle}>{t("remoteWorkspace.noConnectedPeersTitle")}</p>
            <p className={css.emptyDesc}>{t("remoteWorkspace.noConnectedPeersDesc")}</p>
            <Button
              variant="primary"
              onClick={() => {
                controller.close();
                dispatchOpenRemotePeersSettings();
              }}
            >
              {t("remoteWorkspace.openRemotePeersSettings")}
            </Button>
          </div>
        ) : (
          <>
            <div className={css.peerRow}>
              <span className={css.fieldLabel}>{t("remoteWorkspace.peerLabel")}</span>
              {connectedPeers.length > 1 ? (
                <Menu
                  open={peerMenuOpen}
                  onClose={() => setPeerMenuOpen(false)}
                  portal
                  className={css.peerMenu}
                  anchor={
                    <button
                      type="button"
                      className={css.peerTrigger}
                      aria-haspopup="menu"
                      aria-expanded={peerMenuOpen}
                      disabled={busy}
                      onClick={() => setPeerMenuOpen((prev) => !prev)}
                    >
                      <span className={css.peerDot} aria-hidden="true" />
                      <span className={css.peerTriggerName}>{selectedPeer?.name}</span>
                      <span className={css.peerTriggerOrigin}>{selectedPeer?.origin}</span>
                      <IconChevronDownOutlineRegular size={14} className={css.peerChevron} />
                    </button>
                  }
                  items={connectedPeers.map((peer) => ({
                    id: peer.peerId,
                    label: `${peer.name} (${peer.origin})`,
                  }))}
                  selectedId={selectedPeer?.peerId}
                  onSelect={handleSelectPeer}
                />
              ) : (
                <div className={css.peerStatic}>
                  <span className={css.peerDot} aria-hidden="true" />
                  <span className={css.peerTriggerName}>{selectedPeer?.name}</span>
                  <span className={css.peerTriggerOrigin}>{selectedPeer?.origin}</span>
                </div>
              )}
            </div>

            <form className={css.pathBar} onSubmit={handlePathSubmit}>
              <label htmlFor={pathInputId} className={css.srOnly}>
                {t("remoteWorkspace.pathLabel")}
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || dirsLoading || parentPath === null}
                title={t("remoteWorkspace.up")}
                icon={<IconChevronUpOutlineRegular size={14} />}
                onClick={() => {
                  if (selectedPeer !== null && parentPath !== null) {
                    void loadDirectory(selectedPeer.peerId, parentPath);
                  }
                }}
              >
                {t("remoteWorkspace.up")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || dirsLoading || selectedPeer === null}
                onClick={() => {
                  if (selectedPeer !== null) {
                    void loadDirectory(selectedPeer.peerId, homeDir);
                  }
                }}
              >
                {t("remoteWorkspace.home")}
              </Button>
              <input
                id={pathInputId}
                className={css.pathInput}
                value={pathDraft}
                disabled={busy || dirsLoading}
                placeholder={t("remoteWorkspace.pathPlaceholder")}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setPathDraft(event.target.value)}
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={busy || dirsLoading || !pathDraft.trim()}
              >
                {t("remoteWorkspace.go")}
              </Button>
            </form>

            {creatingFolder && (
              <form
                className={css.newFolderForm}
                onSubmit={(event) => void handleCreateFolder(event)}
              >
                <label htmlFor={newFolderInputId} className={css.srOnly}>
                  {t("remoteWorkspace.newFolderPlaceholder")}
                </label>
                <input
                  id={newFolderInputId}
                  className={css.newFolderInput}
                  value={newFolderName}
                  disabled={createFolderBusy}
                  placeholder={t("remoteWorkspace.newFolderPlaceholder")}
                  maxLength={255}
                  autoFocus
                  onChange={(event) => {
                    setNewFolderName(event.target.value);
                    setCreateFolderError(null);
                  }}
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={createFolderBusy || !newFolderName.trim()}
                  aria-busy={createFolderBusy}
                >
                  {t(createFolderBusy ? "remoteWorkspace.creating" : "remoteWorkspace.create")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={createFolderBusy}
                  onClick={() => {
                    setCreatingFolder(false);
                    setNewFolderName("");
                    setCreateFolderError(null);
                  }}
                >
                  {t("connectDevices.cancel")}
                </Button>
              </form>
            )}
            {createFolderError !== null && (
              <p className={css.error} role="alert">
                {createFolderError}
              </p>
            )}

            <div
              className={css.browserBox}
              role="region"
              aria-label={t("remoteWorkspace.dirListLabel")}
            >
              {dirsLoading ? (
                <div className={css.centerState}>
                  <span className={css.spinner}>
                    <IconLoadingOutlineRegular size={16} />
                  </span>
                  <span>{t("remoteWorkspace.loadingDirs")}</span>
                </div>
              ) : dirsError !== null ? (
                <div className={css.centerState} role="alert">
                  <p className={css.error}>{dirsError}</p>
                  {selectedPeer !== null && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void loadDirectory(selectedPeer.peerId, currentPath || undefined)
                      }
                    >
                      {t("remotePeers.retry")}
                    </Button>
                  )}
                </div>
              ) : listing !== null && listing.entries.length === 0 ? (
                <div className={css.centerState}>
                  <span className={css.emptyDirHint}>{t("remoteWorkspace.emptyDir")}</span>
                </div>
              ) : (
                <ul className={css.dirList}>
                  {(listing?.entries ?? []).map((entry) => (
                    <li key={entry.path} className={css.dirItem}>
                      <button
                        type="button"
                        className={css.dirRow}
                        disabled={busy}
                        onClick={() => {
                          if (selectedPeer !== null) {
                            void loadDirectory(selectedPeer.peerId, entry.path);
                          }
                        }}
                      >
                        <IconFolderCloseRegular size={16} className={css.folderIcon} />
                        <span className={css.dirName}>{entry.name}</span>
                        <IconChevronRightOutlineRegular size={14} className={css.dirChevron} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={css.titleField}>
              <label htmlFor={titleInputId} className={css.fieldLabel}>
                {t("remoteWorkspace.customTitleLabel")}
              </label>
              <input
                id={titleInputId}
                className={css.titleInput}
                value={workspaceTitle}
                disabled={submitting}
                maxLength={255}
                placeholder={
                  currentPath
                    ? t("remoteWorkspace.customTitlePlaceholder", { name: basenameOf(currentPath) })
                    : t("remoteWorkspace.customTitlePlaceholderDefault")
                }
                onChange={(event) => setWorkspaceTitle(event.target.value)}
              />
            </div>

            {submitError !== null && (
              <p className={css.error} role="alert">
                {submitError}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
