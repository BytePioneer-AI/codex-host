/**
 * Compact host & workspace scope filter popover mounted in the sidebar section
 * header whenever at least one remote workspace exists.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconPlusOutlineRegular,
  IconSettingsOutlineRegular,
  MenuSurface,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { resolveRemotePeerColor } from "@codexhost/shared-contracts";
import type { WorkspaceView } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import {
  countSelectedWorkspacesForHost,
  deriveAvailableHosts,
  hasRemoteWorkspaces,
  isHostScopeFiltered,
  reconcileHostScopeFilter,
  resetHostScopeFilter,
  selectHostScope,
  setHostSelectedWorkspaceIds,
  setHostWorkspaceScopeMode,
  toggleHostWorkspaceSelection,
  type HostScopeFilterState,
  type HostSummary,
} from "./host-scope-filter.ts";
import css from "./HostScopeFilter.module.css";

const ADD_REMOTE_WORKSPACE_EVENT = "codexhost:open-add-remote-workspace";
const OPEN_REMOTE_PEERS_SETTINGS_EVENT = "codexhost:open-remote-peers-settings";

type Translate = WorkspaceBrowserProps["t"];

export interface HostScopeFilterProps {
  workspaces: readonly WorkspaceView[];
  state: HostScopeFilterState;
  onChange: (next: HostScopeFilterState) => void;
  t: Translate;
}

function hostDisplayLabel(host: HostSummary, t: Translate): string {
  if (host.key === "local") return t("host.local");
  return host.displayName || host.hostId || host.key;
}

function hostStatusLabel(state: string | undefined, t: Translate): string {
  if (state === "connected") return t("host.connected");
  if (state === "connecting") return t("host.connecting");
  return t("host.disconnected");
}

function HostScopeWorkspacesEditor({
  host,
  state,
  onChange,
  t,
}: {
  host: HostSummary;
  state: HostScopeFilterState;
  onChange: (next: HostScopeFilterState) => void;
  t: Translate;
}) {
  const scope = state.perHost[host.key];
  const mode = scope?.mode === "selected" ? "selected" : "all";
  const selectedIds = useMemo(
    () => new Set(scope?.mode === "selected" ? scope.workspaceIds : []),
    [scope],
  );
  const allHostWorkspaceIds = useMemo(
    () => host.workspaces.map((workspace) => workspace.workspaceId),
    [host.workspaces],
  );
  const selectedCount = countSelectedWorkspacesForHost(host, scope);

  return (
    <div className={css.scopeEditor}>
      <div className={css.segmented} role="tablist" aria-label={t("hostScope.scope.label")}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "all"}
          className={clsx(css.segmentButton, mode === "all" && css.segmentActive)}
          onClick={() => {
            onChange(setHostWorkspaceScopeMode(state, host.key, "all", allHostWorkspaceIds));
          }}
        >
          {t("hostScope.scope.allSessions")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "selected"}
          className={clsx(css.segmentButton, mode === "selected" && css.segmentActive)}
          onClick={() => {
            onChange(setHostWorkspaceScopeMode(state, host.key, "selected", allHostWorkspaceIds));
          }}
        >
          {t("hostScope.scope.selectedWorkspaces")}
        </button>
      </div>

      {mode === "selected" && (
        <div className={css.workspacePicker}>
          <div className={css.workspacePickerBar}>
            <span className={css.workspacePickerCount}>
              {t("hostScope.selectedCount", {
                selected: selectedCount,
                total: host.workspaceCount,
              })}
            </span>
            <span className={css.workspacePickerActions}>
              <button
                type="button"
                className={css.miniLink}
                disabled={host.workspaces.length === 0 || selectedCount === host.workspaces.length}
                onClick={() => {
                  onChange(setHostSelectedWorkspaceIds(state, host.key, allHostWorkspaceIds));
                }}
              >
                {t("hostScope.selectAll")}
              </button>
              <button
                type="button"
                className={css.miniLink}
                disabled={selectedCount === 0}
                onClick={() => {
                  onChange(setHostSelectedWorkspaceIds(state, host.key, []));
                }}
              >
                {t("hostScope.clear")}
              </button>
            </span>
          </div>
          {host.workspaces.length === 0 ? (
            <div className={css.noWorkspaces}>{t("hostScope.noHostWorkspaces")}</div>
          ) : (
            <div className={css.workspaceList}>
              {host.workspaces.map((workspace) => {
                const checked = selectedIds.has(workspace.workspaceId);
                return (
                  <label
                    key={workspace.workspaceId}
                    className={css.workspaceOption}
                    title={workspace.path || workspace.title}
                  >
                    <input
                      type="checkbox"
                      className={css.workspaceCheckbox}
                      checked={checked}
                      onChange={() => {
                        onChange(
                          toggleHostWorkspaceSelection(
                            state,
                            host.key,
                            workspace.workspaceId,
                            allHostWorkspaceIds,
                          ),
                        );
                      }}
                    />
                    <span className={css.workspaceOptionName}>{workspace.title}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HostScopeTabBar({ workspaces, state, onChange, t }: HostScopeFilterProps) {
  const hasRemote = useMemo(() => hasRemoteWorkspaces(workspaces), [workspaces]);
  const hosts = useMemo(() => deriveAvailableHosts(workspaces), [workspaces]);
  const effective = useMemo(() => reconcileHostScopeFilter(state, workspaces), [state, workspaces]);

  if (!hasRemote) return null;

  return (
    <div className={css.tabBar} role="tablist" aria-label={t("hostScope.host.label")}>
      <button
        type="button"
        role="tab"
        aria-selected={effective.selectedHost === "all"}
        className={clsx(css.tabItem, effective.selectedHost === "all" && css.tabItemActive)}
        onClick={() => {
          onChange(selectHostScope(effective, "all"));
        }}
      >
        <span className={css.tabLabel}>{t("hostScope.allShort")}</span>
      </button>
      {hosts.map((host) => {
        const selected = effective.selectedHost === host.key;
        const label = hostDisplayLabel(host, t);
        const title =
          host.hostId !== undefined ? `${label} · ${hostStatusLabel(host.state, t)}` : label;
        return (
          <button
            key={host.key}
            type="button"
            role="tab"
            aria-selected={selected}
            className={clsx(css.tabItem, selected && css.tabItemActive)}
            title={title}
            onClick={() => {
              onChange(selectHostScope(effective, host.key));
            }}
          >
            {host.hostId !== undefined && (
              <span
                className={css.tabDot}
                data-state={host.state ?? "disconnected"}
                data-color={resolveRemotePeerColor(host.hostId, host.color)}
                aria-hidden="true"
              />
            )}
            <span className={css.tabLabel}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function HostScopeFilter({ workspaces, state, onChange, t }: HostScopeFilterProps) {
  const [open, setOpen] = useState(false);
  const [expandedAllHostKey, setExpandedAllHostKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();

  const hasRemote = useMemo(() => hasRemoteWorkspaces(workspaces), [workspaces]);
  const hosts = useMemo(() => deriveAvailableHosts(workspaces), [workspaces]);
  const effective = useMemo(() => reconcileHostScopeFilter(state, workspaces), [state, workspaces]);
  const filtered = useMemo(
    () => isHostScopeFiltered(effective, workspaces),
    [effective, workspaces],
  );

  const selectedHostSummary = useMemo(
    () =>
      effective.selectedHost === "all"
        ? undefined
        : hosts.find((host) => host.key === effective.selectedHost),
    [effective.selectedHost, hosts],
  );

  const position = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef,
    side: "bottom",
    align: "end",
    gap: 4,
    margin: 12,
  });

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  if (!hasRemote) return null;

  const triggerLabel = (() => {
    if (!filtered) return t("hostScope.allShort");
    if (selectedHostSummary !== undefined) {
      const base = hostDisplayLabel(selectedHostSummary, t);
      const scope = effective.perHost[selectedHostSummary.key];
      if (scope?.mode === "selected") {
        const count = countSelectedWorkspacesForHost(selectedHostSummary, scope);
        return `${base} · ${count}`;
      }
      return base;
    }
    return t("hostScope.filtered");
  })();

  const selectedRemoteHostId =
    selectedHostSummary?.hostId !== undefined ? selectedHostSummary.hostId : undefined;

  const handleOpenAddRemoteWorkspace = (): void => {
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent(ADD_REMOTE_WORKSPACE_EVENT, {
        detail: selectedRemoteHostId !== undefined ? { hostId: selectedRemoteHostId } : {},
      }),
    );
  };

  const handleOpenRemotePeersSettings = (): void => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent(OPEN_REMOTE_PEERS_SETTINGS_EVENT));
  };

  const totalWorkspaceCount = workspaces.length;

  return (
    <span ref={rootRef} className={css.anchorRoot}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(css.trigger, filtered && css.triggerActive, open && css.triggerOpen)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={t("hostScope.trigger.aria", { current: triggerLabel })}
        title={t("hostScope.trigger.aria", { current: triggerLabel })}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
      >
        {selectedHostSummary?.hostId !== undefined && (
          <span
            className={css.dot}
            data-state={selectedHostSummary.state ?? "disconnected"}
            data-color={resolveRemotePeerColor(
              selectedHostSummary.hostId,
              selectedHostSummary.color,
            )}
            aria-hidden="true"
          />
        )}
        <span className={css.triggerLabel}>{triggerLabel}</span>
        <IconChevronDownOutlineRegular size={12} className={css.triggerChevron} />
      </button>

      {open &&
        createPortal(
          <MenuSurface
            ref={panelRef}
            id={dialogId}
            role="dialog"
            aria-label={t("hostScope.popover.aria")}
            className={css.popover}
            style={position ?? { visibility: "hidden", left: 0, top: 0 }}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className={css.scrollArea}>
              <div className={css.section}>
                <div className={css.sectionTitleRow}>
                  <span className={css.sectionTitle}>{t("hostScope.host.label")}</span>
                  {filtered && (
                    <button
                      type="button"
                      className={css.resetLink}
                      onClick={() => {
                        onChange(resetHostScopeFilter());
                      }}
                    >
                      {t("hostScope.reset")}
                    </button>
                  )}
                </div>

                <div
                  className={css.hostList}
                  role="radiogroup"
                  aria-label={t("hostScope.host.label")}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={effective.selectedHost === "all"}
                    className={clsx(
                      css.hostRow,
                      effective.selectedHost === "all" && css.hostRowSelected,
                    )}
                    onClick={() => {
                      onChange(selectHostScope(effective, "all"));
                    }}
                  >
                    <span className={css.hostName}>{t("hostScope.allHosts")}</span>
                    <span className={css.hostCount}>{totalWorkspaceCount}</span>
                    <span className={css.checkSlot}>
                      {effective.selectedHost === "all" && <IconCheckOutlineRegular size={14} />}
                    </span>
                  </button>

                  {hosts.map((host) => {
                    const selected = effective.selectedHost === host.key;
                    const scope = effective.perHost[host.key];
                    const isSubset = scope?.mode === "selected";
                    const shownCount = countSelectedWorkspacesForHost(host, scope);
                    const countText = isSubset
                      ? `${shownCount}/${host.workspaceCount}`
                      : String(host.workspaceCount);
                    const label = hostDisplayLabel(host, t);
                    const title =
                      host.hostId !== undefined
                        ? `${label} · ${hostStatusLabel(host.state, t)}`
                        : label;
                    return (
                      <button
                        key={host.key}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={clsx(css.hostRow, selected && css.hostRowSelected)}
                        title={title}
                        onClick={() => {
                          onChange(selectHostScope(effective, host.key));
                        }}
                      >
                        {host.hostId !== undefined && (
                          <span
                            className={css.dot}
                            data-state={host.state ?? "disconnected"}
                            data-color={resolveRemotePeerColor(host.hostId, host.color)}
                            aria-hidden="true"
                          />
                        )}
                        <span className={css.hostName}>{label}</span>
                        <span className={clsx(css.hostCount, isSubset && css.hostCountFiltered)}>
                          {countText}
                        </span>
                        <span className={css.checkSlot}>
                          {selected && <IconCheckOutlineRegular size={14} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={css.divider} role="separator" />

              <div className={css.section}>
                <div className={css.sectionTitleRow}>
                  <span className={css.sectionTitle}>{t("hostScope.scope.label")}</span>
                </div>

                {selectedHostSummary !== undefined ? (
                  <HostScopeWorkspacesEditor
                    host={selectedHostSummary}
                    state={effective}
                    onChange={onChange}
                    t={t}
                  />
                ) : (
                  <div className={css.allHostsScopeList}>
                    {hosts.map((host) => {
                      const expanded = expandedAllHostKey === host.key;
                      const scope = effective.perHost[host.key];
                      const isSubset = scope?.mode === "selected";
                      const badge = isSubset
                        ? `${countSelectedWorkspacesForHost(host, scope)}/${host.workspaceCount}`
                        : t("hostScope.allShort");
                      return (
                        <div key={host.key} className={css.perHostAccordion}>
                          <button
                            type="button"
                            className={clsx(css.perHostTrigger, expanded && css.perHostTriggerOpen)}
                            aria-expanded={expanded}
                            onClick={() => {
                              setExpandedAllHostKey((current) =>
                                current === host.key ? null : host.key,
                              );
                            }}
                          >
                            {expanded ? (
                              <IconChevronDownOutlineRegular
                                size={12}
                                className={css.accordionIcon}
                              />
                            ) : (
                              <IconChevronRightOutlineRegular
                                size={12}
                                className={css.accordionIcon}
                              />
                            )}
                            {host.hostId !== undefined && (
                              <span
                                className={css.dot}
                                data-state={host.state ?? "disconnected"}
                                data-color={resolveRemotePeerColor(host.hostId, host.color)}
                                aria-hidden="true"
                              />
                            )}
                            <span className={css.hostName}>{hostDisplayLabel(host, t)}</span>
                            <span
                              className={clsx(
                                css.scopeSummaryTag,
                                isSubset && css.scopeSummaryTagFiltered,
                              )}
                            >
                              {badge}
                            </span>
                          </button>
                          {expanded && (
                            <div className={css.perHostBody}>
                              <HostScopeWorkspacesEditor
                                host={host}
                                state={effective}
                                onChange={onChange}
                                t={t}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className={css.footer}>
              <button
                type="button"
                className={css.footerAction}
                onClick={handleOpenAddRemoteWorkspace}
              >
                <IconPlusOutlineRegular size={14} className={css.footerIcon} />
                <span>{t("hostScope.action.addRemoteWorkspace")}</span>
              </button>
              <button
                type="button"
                className={css.footerAction}
                onClick={handleOpenRemotePeersSettings}
              >
                <IconSettingsOutlineRegular size={14} className={css.footerIcon} />
                <span>{t("hostScope.action.manageRemoteHosts")}</span>
              </button>
            </div>
          </MenuSurface>,
          document.body,
        )}
    </span>
  );
}
