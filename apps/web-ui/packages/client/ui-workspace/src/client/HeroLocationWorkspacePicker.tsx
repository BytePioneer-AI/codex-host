/**
 * Codex-Desktop-style two-part Hero selector mounted inside the docked composer
 * top cap: `[Laptop This computer]` (searchable location popover) paired with
 * `[Folder Choose project]` (searchable host-scoped project popover + New project).
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  Button,
  IconCheckOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineRegular,
  MenuSurface,
  Modal,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
  usePhoneSidebar,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller/client";
import { workspaceDisplayTitle } from "@deepseek-ai/dsh-api-workspace-controller/default-workspace";
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from "./contract/slots.ts";
import {
  buildHeroLocationOptions,
  filterHeroLocations,
  filterHeroProjects,
  findCreatedRemoteWorkspace,
  hostKeyOfWorkspace,
  parseConfiguredRemotePeers,
  workspaceParentHint,
  type ConfiguredRemotePeer,
  type HeroLocationOption,
} from "./hero-picker-model.ts";
import css from "./HeroLocationWorkspacePicker.module.css";

const ADD_REMOTE_WORKSPACE_EVENT = "codexhost:open-add-remote-workspace";
const OPEN_REMOTE_PEERS_SETTINGS_EVENT = "codexhost:open-remote-peers-settings";
const REMOTE_PEERS_UPDATED_EVENT = "codexhost:remote-peers-updated";
const REMOTE_WORKSPACE_CREATED_EVENT = "codexhost:remote-workspace-created";
const REMOTE_PEERS_LIST_METHOD = "codexhost/remote-peers/list";
const NO_PROJECT_ID = "::no-project";

interface PendingRemoteCreateTarget {
  readonly hostId: string;
  readonly path: string;
  readonly workspaceId?: string;
}

function LaptopIcon({ className }: { className?: string }) {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.25" y="2.75" width="11.5" height="8" rx="1.5" />
      <path d="M1.25 12.75h13.5" />
    </svg>
  );
}

function RemoteHostIcon({ className }: { className?: string }) {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="8.5" rx="1.6" />
      <path d="M5.5 13.5h5M8 11v2.5" />
    </svg>
  );
}

function locationLabelOf(location: HeroLocationOption, t: WorkspacePickerProps["t"]): string {
  if (location.key === "local") return t("host.thisComputer");
  return location.displayName || location.hostId || location.key;
}

function statusTextOf(state: string | undefined, t: WorkspacePickerProps["t"]): string | undefined {
  if (state === undefined || state === "connected") return undefined;
  if (state === "connecting") return t("host.connecting");
  return t("host.disconnected");
}

function LocationGlyph({
  location,
  className,
}: {
  location: HeroLocationOption;
  className?: string;
}): ReactNode {
  if (location.key === "local") {
    return <LaptopIcon className={className} />;
  }
  if (location.state !== undefined && location.state !== "connected") {
    return <span className={css.statusDot} data-state={location.state} aria-hidden="true" />;
  }
  return <RemoteHostIcon className={className} />;
}

async function fetchConfiguredRemotePeers(
  signal?: AbortSignal,
): Promise<ConfiguredRemotePeer[] | null> {
  try {
    const rpcId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `hero-peers-${Date.now()}`;
    const response = await fetch(`api/${REMOTE_PEERS_LIST_METHOD}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method: REMOTE_PEERS_LIST_METHOD,
        payload: { args: {} },
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return parseConfiguredRemotePeers(payload);
  } catch {
    return null;
  }
}

/**
 * Two-step Hero location & project picker with independent searchable popovers.
 */
export function HeroLocationWorkspacePicker({
  open: externalProjectOpen,
  selectedId,
  fallbackLabel,
  onOpenChange,
  onPick,
  onClose,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderSlot,
  t,
}: WorkspacePickerProps): ReactNode {
  const workspaceSnapshot = useWorkspaces((state) => state);
  const workspaces = workspaceSnapshot.items;
  const canStartProjectless = workspaceSnapshot.canStartProjectless === true;
  const flowAvailable = useDirectoryFlow((occupied) => occupied);

  const [configuredPeers, setConfiguredPeers] = useState<ConfiguredRemotePeer[]>([]);
  const [peersLoaded, setPeersLoaded] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [localProjectOpen, setLocalProjectOpen] = useState(false);
  const [locationQuery, setLocationQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [locationHighlight, setLocationHighlight] = useState(-1);
  const [projectHighlight, setProjectHighlight] = useState(-1);

  const [flowOpen, setFlowOpen] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const phoneSidebar = usePhoneSidebar();
  const phoneFlowOrigin = useRef(false);

  const awaitingRemoteHostRef = useRef<string | null>(null);
  const [pendingRemoteCreated, setPendingRemoteCreated] =
    useState<PendingRemoteCreateTarget | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const locationTriggerRef = useRef<HTMLButtonElement>(null);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const locationPanelRef = useRef<HTMLDivElement>(null);
  const projectPanelRef = useRef<HTMLDivElement>(null);
  const locationSearchRef = useRef<HTMLInputElement>(null);
  const projectSearchRef = useRef<HTMLInputElement>(null);
  const locationDialogId = useId();
  const projectDialogId = useId();

  const projectOpen = externalProjectOpen || localProjectOpen;
  const flowBusy = flowOpen || pickingFolder;

  const selectedWorkspaceHostKey = useMemo(
    () => hostKeyOfWorkspace(workspaces, selectedId),
    [workspaces, selectedId],
  );

  const locations = useMemo(
    () => buildHeroLocationOptions(workspaces, configuredPeers),
    [workspaces, configuredPeers],
  );
  const availableLocationKeys = useMemo(
    () => new Set(locations.map((loc) => loc.key)),
    [locations],
  );
  const disabledRemoteHostIds = useMemo(
    () => new Set(configuredPeers.filter((peer) => !peer.enabled).map((peer) => peer.hostId)),
    [configuredPeers],
  );
  const workspacesReady = workspaceSnapshot.phase === "ready" && workspaceSnapshot.state === "idle";
  const hostsReady = workspacesReady && peersLoaded;

  const [activeHostKey, setActiveHostKey] = useState<string>(() => selectedWorkspaceHostKey);

  const setProjectOpen = useCallback(
    (next: boolean, keepPendingHost = false): void => {
      setLocalProjectOpen(next);
      onOpenChange?.(next);
      if (!next) {
        if (!keepPendingHost) {
          setActiveHostKey(
            availableLocationKeys.has(selectedWorkspaceHostKey)
              ? selectedWorkspaceHostKey
              : "local",
          );
        }
        onClose();
      }
    },
    [availableLocationKeys, onClose, onOpenChange, selectedWorkspaceHostKey],
  );

  // Sync external `open` transitions (e.g. clicking the inert composer card).
  useEffect(() => {
    if (externalProjectOpen) {
      setLocationOpen(false);
      setLocalProjectOpen(true);
    }
  }, [externalProjectOpen]);

  // Refresh configured remote peers silently so peers with 0 workspaces also appear.
  const refreshPeers = useCallback((signal?: AbortSignal): void => {
    void fetchConfiguredRemotePeers(signal).then((peers) => {
      if (signal?.aborted || peers === null) return;
      setConfiguredPeers(peers);
      setPeersLoaded(true);
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refreshPeers(controller.signal);
    const onPeersUpdated = (): void => {
      refreshPeers();
    };
    window.addEventListener(REMOTE_PEERS_UPDATED_EVENT, onPeersUpdated);
    return () => {
      controller.abort();
      window.removeEventListener(REMOTE_PEERS_UPDATED_EVENT, onPeersUpdated);
    };
  }, [refreshPeers]);

  useEffect(() => {
    if (locationOpen) refreshPeers();
  }, [locationOpen, refreshPeers]);

  // Auto-select a remote workspace newly created from our "+ New project" CTA.
  useEffect(() => {
    const onCreated = (event: Event): void => {
      const detail = (
        event as CustomEvent<{ hostId?: string; path?: string; workspaceId?: string } | undefined>
      ).detail;
      if (!detail || typeof detail.hostId !== "string" || typeof detail.path !== "string") return;
      if (awaitingRemoteHostRef.current === null || detail.hostId !== awaitingRemoteHostRef.current)
        return;
      awaitingRemoteHostRef.current = null;
      setPendingRemoteCreated({
        hostId: detail.hostId,
        path: detail.path,
        ...(typeof detail.workspaceId === "string" ? { workspaceId: detail.workspaceId } : {}),
      });
    };
    window.addEventListener(REMOTE_WORKSPACE_CREATED_EVENT, onCreated);
    return () => {
      window.removeEventListener(REMOTE_WORKSPACE_CREATED_EVENT, onCreated);
    };
  }, []);

  // Follow external selection changes (e.g. clicking "+" next to a workspace in sidebar).
  const prevSelectedIdRef = useRef<WorkspaceId | undefined>(selectedId);
  useEffect(() => {
    if (selectedId !== prevSelectedIdRef.current) {
      prevSelectedIdRef.current = selectedId;
      if (selectedId !== undefined) {
        const nextHostKey = hostKeyOfWorkspace(workspaces, selectedId);
        setActiveHostKey(availableLocationKeys.has(nextHostKey) ? nextHostKey : "local");
      }
    }
  }, [availableLocationKeys, selectedId, workspaces]);

  // If the selected remote workspace arrives after initial hydration, sync host key.
  useEffect(() => {
    if (
      selectedId !== undefined &&
      selectedWorkspaceHostKey !== "local" &&
      availableLocationKeys.has(selectedWorkspaceHostKey)
    ) {
      setActiveHostKey((current) => (current === "local" ? selectedWorkspaceHostKey : current));
    }
  }, [availableLocationKeys, selectedId, selectedWorkspaceHostKey]);

  // Reset active remote host, pending creation targets, and stale remote selection once unavailable.
  const clearedStaleSelectionRef = useRef<WorkspaceId | undefined>(undefined);
  useEffect(() => {
    const isHostGone = (hostKey: string): boolean =>
      hostKey !== "local" &&
      !availableLocationKeys.has(hostKey) &&
      (hostsReady || disabledRemoteHostIds.has(hostKey));

    if (isHostGone(activeHostKey)) {
      setActiveHostKey("local");
    }

    if (awaitingRemoteHostRef.current !== null && isHostGone(awaitingRemoteHostRef.current)) {
      awaitingRemoteHostRef.current = null;
    }

    if (pendingRemoteCreated !== null && isHostGone(pendingRemoteCreated.hostId)) {
      setPendingRemoteCreated(null);
    }

    const currentWorkspace =
      selectedId === undefined
        ? undefined
        : workspaces.find((item) => item.workspaceId === selectedId);
    const selectedHostGone =
      currentWorkspace?.remote !== undefined && isHostGone(currentWorkspace.remote.hostId);
    const awaitingSelectedCreation =
      pendingRemoteCreated !== null &&
      !isHostGone(pendingRemoteCreated.hostId) &&
      pendingRemoteCreated.workspaceId === selectedId;
    const selectedRemoteMissing =
      hostsReady &&
      selectedId !== undefined &&
      currentWorkspace === undefined &&
      !awaitingSelectedCreation &&
      (activeHostKey !== "local" || selectedId.startsWith("remote-peer:"));

    if (selectedHostGone || selectedRemoteMissing) {
      if (canStartProjectless && clearedStaleSelectionRef.current !== selectedId) {
        clearedStaleSelectionRef.current = selectedId;
        onPick(null);
      }
    } else {
      clearedStaleSelectionRef.current = undefined;
    }
  }, [
    activeHostKey,
    availableLocationKeys,
    canStartProjectless,
    disabledRemoteHostIds,
    hostsReady,
    onPick,
    pendingRemoteCreated,
    selectedId,
    workspaces,
  ]);

  // Fall back to "local" if the active remote host disappears completely.
  const activeLocation: HeroLocationOption = useMemo(
    () =>
      locations.find((loc) => loc.key === activeHostKey) ??
      locations[0] ?? {
        key: "local",
        workspaces: [],
      },
    [activeHostKey, locations],
  );

  useEffect(() => {
    if (pendingRemoteCreated === null) return;
    const matched = findCreatedRemoteWorkspace(workspaces, pendingRemoteCreated);
    if (matched === undefined) return;
    setPendingRemoteCreated(null);
    setActiveHostKey(matched.remote?.hostId ?? "local");
    onPick(matched.workspaceId);
  }, [onPick, pendingRemoteCreated, workspaces]);

  // Withdraw open directory flow if occupant unloads.
  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false);
  }, [flowOpen, flowAvailable]);

  const locationPos = useAnchoredPosition({
    open: locationOpen,
    anchorRef: locationTriggerRef,
    panelRef: locationPanelRef,
    side: "bottom",
    align: "start",
    gap: 6,
    margin: 12,
  });

  const projectPos = useAnchoredPosition({
    open: projectOpen,
    anchorRef: projectTriggerRef,
    panelRef: projectPanelRef,
    side: "bottom",
    align: "start",
    gap: 6,
    margin: 12,
  });

  useDismissOnOutsidePointer(rootRef, locationOpen, setLocationOpen, locationPanelRef);
  useDismissOnOutsidePointer(
    rootRef,
    projectOpen,
    useCallback(
      (next: boolean) => {
        if (!next) setProjectOpen(false);
      },
      [setProjectOpen],
    ),
    projectPanelRef,
  );

  // Focus search inputs and reset queries/highlights on popover open (no forced initial hover).
  useEffect(() => {
    if (!locationOpen) return;
    setLocationQuery("");
    setLocationHighlight(-1);
    const frame = requestAnimationFrame(() => {
      locationSearchRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [locationOpen]);

  useEffect(() => {
    if (!projectOpen) return;
    setProjectQuery("");
    setProjectHighlight(-1);
    const frame = requestAnimationFrame(() => {
      projectSearchRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [projectOpen]);

  // Escape closes whichever popover is open.
  useEffect(() => {
    if (!locationOpen && !projectOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (locationOpen) {
        setLocationOpen(false);
        locationTriggerRef.current?.focus({ preventScroll: true });
      } else if (projectOpen) {
        setProjectOpen(false);
        projectTriggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [locationOpen, projectOpen, setProjectOpen]);

  const titleOf = useCallback(
    (workspace: { readonly title: string }) =>
      workspaceDisplayTitle(workspace.title, t("workspace.defaultName")),
    [t],
  );

  const filteredLocations = useMemo(
    () => filterHeroLocations(locations, locationQuery, t("host.thisComputer")),
    [locations, locationQuery, t],
  );

  const filteredProjects = useMemo(
    () => filterHeroProjects(activeLocation.workspaces, projectQuery, titleOf),
    [activeLocation.workspaces, projectQuery, titleOf],
  );

  const showNoProjectOption =
    activeLocation.key === "local" && canStartProjectless && projectQuery.trim() === "";

  const projectRows = useMemo(
    () => [
      ...(showNoProjectOption ? [{ id: NO_PROJECT_ID as string, workspace: undefined }] : []),
      ...filteredProjects.map((workspace) => ({ id: workspace.workspaceId, workspace })),
    ],
    [filteredProjects, showNoProjectOption],
  );

  useEffect(() => {
    setLocationHighlight((prev) =>
      filteredLocations.length === 0 ? -1 : prev >= filteredLocations.length ? 0 : prev,
    );
  }, [filteredLocations.length]);

  useEffect(() => {
    setProjectHighlight((prev) =>
      projectRows.length === 0 ? -1 : prev >= projectRows.length ? 0 : prev,
    );
  }, [projectRows.length]);

  const hasRemoteLocations = locations.length > 1;
  const activeLocationLabel = locationLabelOf(activeLocation, t);

  const selectedWorkspace = useMemo(
    () =>
      selectedId === undefined
        ? undefined
        : workspaces.find((item) => item.workspaceId === selectedId),
    [selectedId, workspaces],
  );

  const selectedMatchesActiveHost =
    selectedWorkspace !== undefined &&
    (selectedWorkspace.remote?.hostId ?? "local") === activeLocation.key;

  const projectTriggerLabel = (() => {
    if (selectedMatchesActiveHost && selectedWorkspace !== undefined) {
      return titleOf(selectedWorkspace);
    }
    if (selectedId === undefined && activeLocation.key === "local" && fallbackLabel !== undefined) {
      return fallbackLabel;
    }
    return t("heroPicker.project.choose");
  })();

  const projectIsPlaceholder =
    !selectedMatchesActiveHost &&
    !(selectedId === undefined && activeLocation.key === "local" && fallbackLabel !== undefined);

  const handleSelectLocation = (location: HeroLocationOption): void => {
    const changed = location.key !== activeLocation.key;
    setActiveHostKey(location.key);
    setLocationOpen(false);
    if (changed) {
      setProjectOpen(true);
    }
  };

  const handleSelectProject = (id: string): void => {
    awaitingRemoteHostRef.current = null;
    setProjectOpen(false, true);
    if (id === NO_PROJECT_ID) {
      onPick(null);
      return;
    }
    onPick(id as WorkspaceId);
  };

  const openLocalDirectoryFlow = useCallback((): void => {
    awaitingRemoteHostRef.current = null;
    phoneFlowOrigin.current = phoneSidebar?.open === true;
    setProjectOpen(false, true);
    setErrorOpen(false);
    setModalError(null);
    setFlowOpen(true);
  }, [phoneSidebar?.open, setProjectOpen]);

  const handleNewProject = (): void => {
    if (activeLocation.key === "local") {
      if (flowAvailable && !flowBusy) openLocalDirectoryFlow();
      return;
    }
    if (activeLocation.hostId?.startsWith("remote-peer:") && activeLocation.state === "connected") {
      setProjectOpen(false);
      awaitingRemoteHostRef.current = activeLocation.hostId;
      window.dispatchEvent(
        new CustomEvent(ADD_REMOTE_WORKSPACE_EVENT, {
          detail: { hostId: activeLocation.hostId },
        }),
      );
    }
  };

  const canCreateProjectOnActiveHost =
    activeLocation.key === "local"
      ? flowAvailable
      : activeLocation.hostId?.startsWith("remote-peer:") === true &&
        activeLocation.state === "connected";

  const handleOpenRemoteSettings = (): void => {
    setLocationOpen(false);
    window.dispatchEvent(new CustomEvent(OPEN_REMOTE_PEERS_SETTINGS_EVENT));
  };

  const adoptDirectory = (path: string): Promise<void> =>
    createWorkspace({ path })
      .then((workspace) => {
        setFlowOpen(false);
        setActiveHostKey("local");
        onPick(workspace.workspaceId);
      })
      .catch((reason: unknown) => {
        setModalError(reason instanceof Error ? reason.message : String(reason));
        setFlowOpen(false);
        setErrorOpen(true);
      });

  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen,
    busy: pickingFolder,
    onPicked: (path) => {
      setPickingFolder(true);
      void adoptDirectory(path).finally(() => {
        setPickingFolder(false);
      });
    },
    onCancel: () => {
      setFlowOpen(false);
    },
    onError: (message) => {
      setFlowOpen(false);
      setModalError(message);
      setErrorOpen(true);
    },
  };

  const handleLocationSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (filteredLocations.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setLocationHighlight((i) => (i < 0 ? 0 : (i + 1) % filteredLocations.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setLocationHighlight((i) =>
        i < 0
          ? filteredLocations.length - 1
          : (i - 1 + filteredLocations.length) % filteredLocations.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = filteredLocations[locationHighlight >= 0 ? locationHighlight : 0];
      if (target !== undefined) handleSelectLocation(target);
    }
  };

  const handleProjectSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (projectRows.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setProjectHighlight((i) => (i < 0 ? 0 : (i + 1) % projectRows.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setProjectHighlight((i) =>
        i < 0 ? projectRows.length - 1 : (i - 1 + projectRows.length) % projectRows.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = projectRows[projectHighlight >= 0 ? projectHighlight : 0];
      if (target !== undefined) handleSelectProject(target.id);
    }
  };

  const closeModal = (): void => {
    setErrorOpen(false);
    setModalError(null);
  };

  return (
    <div ref={rootRef} className={css.root} data-hero-location-picker="">
      <button
        ref={locationTriggerRef}
        type="button"
        className={clsx(css.trigger, css.triggerLocation, locationOpen && css.triggerOpen)}
        aria-haspopup="dialog"
        aria-expanded={locationOpen}
        aria-controls={locationOpen ? locationDialogId : undefined}
        aria-label={t("heroPicker.location.aria", { current: activeLocationLabel })}
        disabled={flowBusy}
        data-hero-location-trigger=""
        onClick={() => {
          setProjectOpen(false);
          setLocationOpen((prev) => !prev);
        }}
      >
        <LocationGlyph location={activeLocation} className={css.triggerIcon} />
        <span className={css.triggerLabel}>{activeLocationLabel}</span>
      </button>

      <button
        ref={projectTriggerRef}
        type="button"
        className={clsx(
          css.trigger,
          css.triggerProject,
          projectIsPlaceholder && css.triggerPlaceholder,
          projectOpen && css.triggerOpen,
        )}
        aria-haspopup="dialog"
        aria-expanded={projectOpen}
        aria-controls={projectOpen ? projectDialogId : undefined}
        aria-label={t("heroPicker.project.aria", { current: projectTriggerLabel })}
        disabled={flowBusy}
        data-hero-project-trigger=""
        onClick={() => {
          setLocationOpen(false);
          setProjectOpen(!projectOpen);
        }}
      >
        {projectIsPlaceholder ? (
          <IconFolderCloseRegular size={15} className={css.triggerIcon} />
        ) : (
          <IconFolderOpenOutlineRegular size={15} className={css.triggerIcon} />
        )}
        <span className={css.triggerLabel}>{projectTriggerLabel}</span>
      </button>

      {locationOpen &&
        createPortal(
          <MenuSurface
            ref={locationPanelRef}
            id={locationDialogId}
            role="dialog"
            aria-label={t("heroPicker.location.placeholder")}
            className={clsx(css.popover, css.popoverLocation)}
            style={locationPos ?? { visibility: "hidden", left: 0, top: 0 }}
            data-hero-location-popover=""
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className={css.searchRow}>
              <IconSearchOutlineRegular size={15} className={css.searchIcon} />
              <input
                ref={locationSearchRef}
                type="text"
                className={css.searchInput}
                value={locationQuery}
                placeholder={t("heroPicker.location.placeholder")}
                aria-label={t("heroPicker.location.placeholder")}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => {
                  setLocationQuery(event.target.value);
                  setLocationHighlight(event.target.value.trim() === "" ? -1 : 0);
                }}
                onKeyDown={handleLocationSearchKeyDown}
              />
            </div>

            <div className={css.divider} role="separator" />

            <div
              className={css.list}
              role="listbox"
              aria-label={t("heroPicker.location.placeholder")}
              onMouseLeave={() => setLocationHighlight(-1)}
            >
              {filteredLocations.length === 0 ? (
                <div className={css.emptyState}>{t("heroPicker.location.empty")}</div>
              ) : (
                filteredLocations.map((location, index) => {
                  const selected = location.key === activeLocation.key;
                  const label = locationLabelOf(location, t);
                  const statusText = statusTextOf(location.state, t);
                  return (
                    <button
                      key={location.key}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={clsx(css.row, index === locationHighlight && css.rowActive)}
                      onMouseEnter={() => setLocationHighlight(index)}
                      onClick={() => handleSelectLocation(location)}
                    >
                      <span className={css.rowIcon}>
                        <LocationGlyph location={location} />
                      </span>
                      <span className={css.rowMain}>
                        <span className={css.rowTitle}>{label}</span>
                      </span>
                      {statusText !== undefined && (
                        <span className={css.rowStatus}>{statusText}</span>
                      )}
                      <span className={css.checkSlot}>
                        {selected && <IconCheckOutlineRegular size={15} />}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            <div className={css.footerDivider} role="separator" />

            <button type="button" className={css.footerAction} onClick={handleOpenRemoteSettings}>
              {hasRemoteLocations ? (
                <IconSettingsOutlineRegular size={15} className={css.footerIcon} />
              ) : (
                <IconPlusOutlineRegular size={15} className={css.footerIcon} />
              )}
              <span>
                {t(
                  hasRemoteLocations
                    ? "heroPicker.location.manageRemote"
                    : "heroPicker.location.connectRemote",
                )}
              </span>
            </button>
          </MenuSurface>,
          document.body,
        )}

      {projectOpen &&
        createPortal(
          <MenuSurface
            ref={projectPanelRef}
            id={projectDialogId}
            role="dialog"
            aria-label={t("heroPicker.project.placeholder")}
            className={clsx(css.popover, css.popoverProject)}
            style={projectPos ?? { visibility: "hidden", left: 0, top: 0 }}
            data-hero-project-popover=""
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className={css.searchRow}>
              <IconSearchOutlineRegular size={15} className={css.searchIcon} />
              <input
                ref={projectSearchRef}
                type="text"
                className={css.searchInput}
                value={projectQuery}
                placeholder={t("heroPicker.project.placeholder")}
                aria-label={t("heroPicker.project.placeholder")}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => {
                  setProjectQuery(event.target.value);
                  setProjectHighlight(event.target.value.trim() === "" ? -1 : 0);
                }}
                onKeyDown={handleProjectSearchKeyDown}
              />
            </div>

            <div className={css.divider} role="separator" />

            <div
              className={css.list}
              role="listbox"
              aria-label={t("heroPicker.project.placeholder")}
              onMouseLeave={() => setProjectHighlight(-1)}
            >
              {workspaceSnapshot.phase === "pending" && projectRows.length === 0 ? (
                <div className={css.emptyState} role="status">
                  {t("picker.loading")}
                </div>
              ) : projectRows.length === 0 ? (
                <div className={css.emptyState}>
                  {projectQuery.trim() !== ""
                    ? t("heroPicker.project.noMatches")
                    : t("heroPicker.project.empty")}
                </div>
              ) : (
                projectRows.map((entry, index) => {
                  const isNone = entry.workspace === undefined;
                  const selected = isNone ? selectedId === undefined : entry.id === selectedId;
                  const label = isNone
                    ? t("heroPicker.project.noProject")
                    : titleOf(entry.workspace);
                  const hint = isNone
                    ? undefined
                    : workspaceParentHint(entry.workspace.path, label);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={clsx(css.row, index === projectHighlight && css.rowActive)}
                      title={entry.workspace?.path || label}
                      onMouseEnter={() => setProjectHighlight(index)}
                      onClick={() => handleSelectProject(entry.id)}
                    >
                      <span className={css.rowIcon}>
                        <IconFolderCloseRegular size={15} />
                      </span>
                      <span className={css.rowMain}>
                        <span className={css.rowTitle}>{label}</span>
                        {hint !== undefined && <span className={css.rowHint}>{hint}</span>}
                      </span>
                      <span className={css.checkSlot}>
                        {selected && <IconCheckOutlineRegular size={15} />}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {canCreateProjectOnActiveHost && (
              <>
                <div className={css.footerDivider} role="separator" />
                <button
                  type="button"
                  className={css.footerAction}
                  disabled={flowBusy}
                  onClick={handleNewProject}
                >
                  <IconPlusOutlineRegular size={15} className={css.footerIcon} />
                  <span>{t("heroPicker.project.new")}</span>
                </button>
              </>
            )}
          </MenuSurface>,
          document.body,
        )}

      {renderSlot("conversation.hero.workspace.directoryFlow", flowOwner)}

      <Modal
        phoneSidebar
        phoneSidebarOrigin={phoneFlowOrigin.current}
        open={errorOpen}
        onClose={closeModal}
        closeLabel={t("close")}
        title={t("folderError.title")}
        footer={
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeModal}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              className={css.modalAction}
              disabled={!flowAvailable}
              onClick={openLocalDirectoryFlow}
            >
              {t("folderError.retry")}
            </Button>
          </>
        }
      >
        <div className={css.modalError} role="alert">
          {modalError}
        </div>
      </Modal>
    </div>
  );
}
