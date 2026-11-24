/** Finder-sheet modal directory browser for adding a workspace on a connected remote peer. */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import {
  Button,
  IconChevronDownOutlineRegular,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
  IconFolderCloseRegular,
  IconGlobeOutlineRegular,
  IconLoadingOutlineRegular,
  IconPlusOutlineRegular,
  Menu,
  Modal,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { RemotePeerListDirsResult, RemotePeerSummary } from "@codexhost/shared-contracts";
import { remotePeersApi } from "./api.ts";
import {
  dispatchOpenRemotePeersSettings,
  dispatchRemotePeersUpdated,
  dispatchRemoteWorkspaceCreated,
} from "./remote-peers-events.ts";
import { HomeIcon, RemoteHostIcon } from "./RemoteHostIcon.tsx";
import { buildBreadcrumbs } from "./remote-workspace-paths.ts";
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

export function RemoteWorkspaceDialog({ controller, t }: Props): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const [peersLoading, setPeersLoading] = useState(false);
  const [peersError, setPeersError] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<RemotePeerSummary[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [peerMenuOpen, setPeerMenuOpen] = useState(false);

  const [listing, setListing] = useState<RemotePeerListDirsResult | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<{ name: string; path: string } | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [dirsLoading, setDirsLoading] = useState(false);
  const [dirsError, setDirsError] = useState<string | null>(null);

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createFolderBusy, setCreateFolderBusy] = useState(false);
  const [createFolderError, setCreateFolderError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const listRequestSeq = useRef(0);
  const pathInputId = useId();
  const newFolderInputId = useId();

  const selectedPeer = connectedPeers.find((peer) => peer.peerId === selectedPeerId) ?? null;

  const loadDirectory = useCallback(async (peerId: string, path?: string): Promise<void> => {
    const seq = ++listRequestSeq.current;
    setDirsLoading(true);
    setDirsError(null);
    setSelectedEntry(null);
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
    setSelectedEntry(null);
    setEditingPath(false);
    setPathDraft("");
    setDirsError(null);
    setCreatingFolder(false);
    setNewFolderName("");
    setCreateFolderError(null);
    setSubmitError(null);

    void remotePeersApi
      .list()
      .then((result) => {
        if (cancelled) return;
        const available = result.peers.filter((peer) => peer.enabled && peer.state === "connected");
        setConnectedPeers(available);
        const chosen =
          state.initialHostId !== undefined
            ? (available.find((peer) => peer.hostId === state.initialHostId) ?? null)
            : (available[0] ?? null);
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

  const currentPath = listing?.path ?? "";
  const homeDir = listing?.homeDir ?? selectedPeer?.homeDir;
  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath, homeDir), [currentPath, homeDir]);

  if (!state.open) return null;

  const busy = submitting || createFolderBusy;
  const targetPath = selectedEntry?.path ?? currentPath;

  const handleSelectPeer = (peerId: string): void => {
    setPeerMenuOpen(false);
    if (peerId === selectedPeerId) return;
    setSelectedPeerId(peerId);
    setListing(null);
    setSelectedEntry(null);
    setEditingPath(false);
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
    setEditingPath(false);
    if (!target || target === currentPath) {
      setPathDraft(currentPath);
      return;
    }
    void loadDirectory(selectedPeer.peerId, target);
  };

  const handlePathKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setEditingPath(false);
      setPathDraft(currentPath);
    }
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

  const handleNewFolderKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setCreatingFolder(false);
      setNewFolderName("");
      setCreateFolderError(null);
    }
  };

  const handleAddWorkspace = async (): Promise<void> => {
    if (selectedPeer === null || !targetPath) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await remotePeersApi.createWorkspace({
        peerId: selectedPeer.peerId,
        path: targetPath,
      });
      dispatchRemotePeersUpdated();
      dispatchRemoteWorkspaceCreated({
        hostId: selectedPeer.hostId,
        path: targetPath,
        ...(created.workspaceId !== undefined ? { workspaceId: created.workspaceId } : {}),
      });
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

  const primaryLabel = submitting
    ? t("remoteWorkspace.adding")
    : selectedEntry !== null
      ? t("remoteWorkspace.addSelected", { name: selectedEntry.name })
      : t("remoteWorkspace.addCurrent");

  return (
    <Modal
      open={state.open}
      onClose={close}
      title={t("remoteWorkspace.title")}
      headless
      className={css.dialog}
    >
      <div className={css.header}>
        <div className={css.headerLead}>
          <h2 className={css.title}>{t("remoteWorkspace.title")}</h2>
          {selectedPeer !== null &&
            (connectedPeers.length > 1 ? (
              <Menu
                open={peerMenuOpen}
                onClose={() => setPeerMenuOpen(false)}
                portal
                align="start"
                items={connectedPeers.map((peer) => ({
                  id: peer.peerId,
                  label: peer.name,
                }))}
                selectedId={selectedPeer.peerId}
                onSelect={handleSelectPeer}
                anchor={
                  <button
                    type="button"
                    className={css.hostPill}
                    aria-label={t("remoteWorkspace.switchHost")}
                    aria-haspopup="menu"
                    aria-expanded={peerMenuOpen}
                    disabled={busy}
                    onClick={() => setPeerMenuOpen((prev) => !prev)}
                  >
                    <RemoteHostIcon size={12} className={css.hostIcon} />
                    <span className={css.hostPillName}>{selectedPeer.name}</span>
                    <IconChevronDownOutlineRegular size={12} className={css.hostPillChevron} />
                  </button>
                }
              />
            ) : (
              <span className={css.hostPillStatic} title={selectedPeer.origin}>
                <RemoteHostIcon size={12} className={css.hostIcon} />
                <span className={css.hostPillName}>{selectedPeer.name}</span>
              </span>
            ))}
        </div>
        <button
          type="button"
          className={css.closeButton}
          aria-label={t("connectDevices.close")}
          onClick={close}
        >
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className={css.body}>
        {peersLoading ? (
          <div className={css.centerState}>
            <span className={css.spinner}>
              <IconLoadingOutlineRegular size={16} />
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
        ) : connectedPeers.length === 0 || selectedPeer === null ? (
          <div className={css.emptyState}>
            <IconGlobeOutlineRegular size={24} className={css.emptyIcon} />
            <p className={css.emptyTitle}>{t("remoteWorkspace.noConnectedPeersTitle")}</p>
            <p className={css.emptyDesc}>{t("remoteWorkspace.noConnectedPeersDesc")}</p>
            <Button
              variant="primary"
              size="sm"
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
            <div className={css.pathBar}>
              {editingPath ? (
                <form className={css.pathEditForm} onSubmit={handlePathSubmit}>
                  <label htmlFor={pathInputId} className={css.srOnly}>
                    {t("remoteWorkspace.pathLabel")}
                  </label>
                  <input
                    id={pathInputId}
                    className={css.pathInput}
                    value={pathDraft}
                    disabled={busy || dirsLoading}
                    placeholder={t("remoteWorkspace.pathPlaceholder")}
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus
                    onChange={(event) => setPathDraft(event.target.value)}
                    onKeyDown={handlePathKeyDown}
                  />
                  <button
                    type="button"
                    className={css.pathIconBtn}
                    aria-label={t("connectDevices.cancel")}
                    onClick={() => {
                      setEditingPath(false);
                      setPathDraft(currentPath);
                    }}
                  >
                    <IconCloseOutlineRegular size={12} />
                  </button>
                </form>
              ) : (
                <>
                  <Tooltip label={homeDir ?? t("remoteWorkspace.home")} side="top" delayMs={400}>
                    <button
                      type="button"
                      className={clsx(
                        css.homeBtn,
                        breadcrumbs.inHome && breadcrumbs.segments.length === 0 && css.crumbCurrent,
                      )}
                      aria-label={t("remoteWorkspace.home")}
                      disabled={busy || dirsLoading || selectedPeer === null}
                      onClick={() => {
                        if (selectedPeer !== null) {
                          void loadDirectory(selectedPeer.peerId, homeDir);
                        }
                      }}
                    >
                      <HomeIcon />
                    </button>
                  </Tooltip>

                  <div
                    className={css.breadcrumbs}
                    title={currentPath}
                    onDoubleClick={() => {
                      if (!busy && !dirsLoading) {
                        setPathDraft(currentPath);
                        setEditingPath(true);
                      }
                    }}
                  >
                    {!breadcrumbs.inHome && breadcrumbs.rootSegment !== null && (
                      <button
                        type="button"
                        className={clsx(
                          css.crumbBtn,
                          breadcrumbs.segments.length === 0 && css.crumbCurrent,
                        )}
                        disabled={busy || dirsLoading}
                        onClick={() => {
                          if (selectedPeer !== null && breadcrumbs.rootSegment !== null) {
                            void loadDirectory(selectedPeer.peerId, breadcrumbs.rootSegment.path);
                          }
                        }}
                      >
                        {breadcrumbs.rootSegment.name}
                      </button>
                    )}
                    {breadcrumbs.segments.map((segment, index) => {
                      const isLast = index === breadcrumbs.segments.length - 1;
                      return (
                        <span key={segment.path} className={css.crumbItem}>
                          <span className={css.crumbSep} aria-hidden="true">
                            /
                          </span>
                          <button
                            type="button"
                            className={clsx(css.crumbBtn, isLast && css.crumbCurrent)}
                            disabled={busy || dirsLoading}
                            onClick={() => {
                              if (selectedPeer !== null && !isLast) {
                                void loadDirectory(selectedPeer.peerId, segment.path);
                              }
                            }}
                          >
                            {segment.name}
                          </button>
                        </span>
                      );
                    })}
                  </div>

                  <div className={css.pathActions}>
                    <Tooltip label={t("remoteWorkspace.editPath")} side="top" delayMs={400}>
                      <button
                        type="button"
                        className={css.pathIconBtn}
                        aria-label={t("remoteWorkspace.editPath")}
                        disabled={busy || dirsLoading}
                        onClick={() => {
                          setPathDraft(currentPath);
                          setEditingPath(true);
                        }}
                      >
                        <IconEditOutlineRegular size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t("remoteWorkspace.newFolder")} side="top" delayMs={400}>
                      <button
                        type="button"
                        className={clsx(css.pathIconBtn, creatingFolder && css.pathIconBtnActive)}
                        aria-label={t("remoteWorkspace.newFolder")}
                        aria-pressed={creatingFolder}
                        disabled={busy || dirsLoading || !currentPath}
                        onClick={() => {
                          setCreatingFolder((prev) => !prev);
                          setCreateFolderError(null);
                          setNewFolderName("");
                        }}
                      >
                        <IconPlusOutlineRegular size={14} />
                      </button>
                    </Tooltip>
                  </div>
                </>
              )}
            </div>

            <div
              className={css.browserBox}
              role="listbox"
              aria-label={t("remoteWorkspace.dirListLabel")}
              onClick={(event) => {
                if (event.target === event.currentTarget) setSelectedEntry(null);
              }}
            >
              {creatingFolder && (
                <div className={css.inlineCreateWrap}>
                  <form
                    className={css.inlineCreateRow}
                    onSubmit={(event) => void handleCreateFolder(event)}
                  >
                    <IconFolderCloseRegular size={15} className={css.folderIcon} />
                    <label htmlFor={newFolderInputId} className={css.srOnly}>
                      {t("remoteWorkspace.newFolderPlaceholder")}
                    </label>
                    <input
                      id={newFolderInputId}
                      className={css.inlineCreateInput}
                      value={newFolderName}
                      disabled={createFolderBusy}
                      placeholder={t("remoteWorkspace.newFolderPlaceholder")}
                      maxLength={255}
                      autoFocus
                      onChange={(event) => {
                        setNewFolderName(event.target.value);
                        setCreateFolderError(null);
                      }}
                      onKeyDown={handleNewFolderKeyDown}
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
                    <button
                      type="button"
                      className={css.pathIconBtn}
                      aria-label={t("connectDevices.cancel")}
                      disabled={createFolderBusy}
                      onClick={() => {
                        setCreatingFolder(false);
                        setNewFolderName("");
                        setCreateFolderError(null);
                      }}
                    >
                      <IconCloseOutlineRegular size={12} />
                    </button>
                  </form>
                  {createFolderError !== null && (
                    <p className={css.inlineCreateError} role="alert">
                      {createFolderError}
                    </p>
                  )}
                </div>
              )}

              {dirsLoading ? (
                <div className={css.centerState}>
                  <span className={css.spinner}>
                    <IconLoadingOutlineRegular size={15} />
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
                  {(listing?.entries ?? []).map((entry) => {
                    const selected = selectedEntry?.path === entry.path;
                    return (
                      <li key={entry.path} className={css.dirItem}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={clsx(css.dirRow, selected && css.dirRowSelected)}
                          disabled={busy}
                          onClick={() => {
                            setSelectedEntry((current) =>
                              current?.path === entry.path ? null : entry,
                            );
                          }}
                          onDoubleClick={() => {
                            if (selectedPeer !== null) {
                              void loadDirectory(selectedPeer.peerId, entry.path);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && selectedPeer !== null) {
                              event.preventDefault();
                              void loadDirectory(selectedPeer.peerId, entry.path);
                            }
                          }}
                        >
                          <IconFolderCloseRegular size={15} className={css.folderIcon} />
                          <span className={css.dirName}>{entry.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {submitError !== null && (
              <p className={css.error} role="alert">
                {submitError}
              </p>
            )}
          </>
        )}
      </div>

      <div className={css.footer}>
        {selectedPeer !== null ? (
          <>
            <Button variant="ghost" size="sm" disabled={submitting} onClick={close}>
              {t("connectDevices.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={submitting || dirsLoading || !targetPath}
              aria-busy={submitting}
              onClick={() => void handleAddWorkspace()}
            >
              {primaryLabel}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={close}>
            {t("connectDevices.close")}
          </Button>
        )}
      </div>
    </Modal>
  );
}
