/**
 * Pure state, persistence, and filtering helpers for the sidebar host &
 * workspace scope filter. Keeps storage parsing defensive and preserves saved
 * per-host workspace subsets when a remote host disconnects or disappears.
 */
import type { WorkspaceView } from "@deepseek-ai/dsh-api-workspace-controller/client";

export const HOST_SCOPE_FILTER_STORAGE_KEY = "codexhost.sidebar.hostScopeFilter.v1";

export type HostScopeTarget = "all" | "local" | string;

export interface PerHostWorkspaceScope {
  mode: "all" | "selected";
  workspaceIds: string[];
}

export interface HostScopeFilterState {
  /** Which host to display: "all", "local", or a specific remote hostId. */
  selectedHost: HostScopeTarget;
  /** Per-host workspace subset configuration (keyed by "local" or remote hostId). */
  perHost: Record<string, PerHostWorkspaceScope>;
}

export interface HostSummary {
  /** Stable host key: "local" or a remote hostId. */
  key: string;
  /** Remote host identifier; absent for the local host. */
  hostId?: string;
  /** Remote host display name; absent for the local host. */
  displayName?: string;
  /** Remote connection state ("connected" | "connecting" | "disconnected" | ...). */
  state?: string;
  /** Number of workspaces belonging to this host. */
  workspaceCount: number;
  /** Workspaces belonging to this host in their incoming order. */
  workspaces: WorkspaceView[];
}

export type SessionFilterInput =
  | string
  | {
      readonly id: string;
      readonly remote?: { readonly hostId: string } | null | undefined;
      readonly projectionValues?:
        { readonly remoteHost?: { readonly hostId: string } | null | undefined } | undefined;
    };

export const DEFAULT_HOST_SCOPE_FILTER_STATE: HostScopeFilterState = {
  selectedHost: "all",
  perHost: {},
};

/** Whether any workspace belongs to a remote host. */
export function hasRemoteWorkspaces(workspaces: readonly WorkspaceView[]): boolean {
  return workspaces.some((workspace) => workspace.remote !== undefined);
}

/** Whether any workspace belongs to a peer-hub remote host (`remote-peer:*`). */
export function hasRemotePeerWorkspaces(workspaces: readonly WorkspaceView[]): boolean {
  return workspaces.some(
    (workspace) => workspace.remote?.hostId.startsWith("remote-peer:") === true,
  );
}

/**
 * Derive available hosts from the workspace list: `"local"` (whenever local
 * workspaces exist or any remote workspace exists) followed by each unique
 * `remote.hostId` in stable first-appearance order.
 */
export function deriveAvailableHosts(workspaces: readonly WorkspaceView[]): HostSummary[] {
  const localWorkspaces: WorkspaceView[] = [];
  const remoteByHostId = new Map<string, HostSummary>();

  for (const workspace of workspaces) {
    const remote = workspace.remote;
    if (remote === undefined) {
      localWorkspaces.push(workspace);
      continue;
    }
    const existing = remoteByHostId.get(remote.hostId);
    if (existing !== undefined) {
      existing.workspaces.push(workspace);
      existing.workspaceCount += 1;
    } else {
      remoteByHostId.set(remote.hostId, {
        key: remote.hostId,
        hostId: remote.hostId,
        displayName: remote.displayName,
        state: remote.state,
        workspaceCount: 1,
        workspaces: [workspace],
      });
    }
  }

  if (localWorkspaces.length === 0 && remoteByHostId.size === 0) return [];

  const hosts: HostSummary[] = [
    {
      key: "local",
      workspaceCount: localWorkspaces.length,
      workspaces: localWorkspaces,
    },
    ...remoteByHostId.values(),
  ];
  return hosts;
}

/**
 * Reconcile saved filter state against current workspaces: if `selectedHost`
 * points to a host that is no longer present, fall back to `"all"` in the
 * effective view while preserving saved `perHost` subset preferences.
 */
export function reconcileHostScopeFilter(
  state: HostScopeFilterState,
  workspaces: readonly WorkspaceView[],
): HostScopeFilterState {
  if (state.selectedHost === "all") return state;
  const hosts = deriveAvailableHosts(workspaces);
  if (hosts.some((host) => host.key === state.selectedHost)) return state;
  return {
    ...state,
    selectedHost: "all",
  };
}

/**
 * Whether any host or visible per-host workspace subset filter is currently active.
 */
export function isHostScopeFiltered(
  state: HostScopeFilterState,
  workspaces: readonly WorkspaceView[],
): boolean {
  const effective = reconcileHostScopeFilter(state, workspaces);
  if (effective.selectedHost !== "all") return true;
  const hosts = deriveAvailableHosts(workspaces);
  return hosts.some((host) => effective.perHost[host.key]?.mode === "selected");
}

/** Filter workspaces by selected host and per-host workspace subsets. */
export function filterWorkspacesByHostScope(
  workspaces: readonly WorkspaceView[],
  state: HostScopeFilterState,
): WorkspaceView[] {
  const effective = reconcileHostScopeFilter(state, workspaces);
  return workspaces.filter((workspace) => {
    const hostKey = workspace.remote?.hostId ?? "local";
    if (effective.selectedHost === "local") {
      if (workspace.remote !== undefined) return false;
    } else if (effective.selectedHost !== "all") {
      if (workspace.remote?.hostId !== effective.selectedHost) return false;
    }
    const hostScope = effective.perHost[hostKey];
    if (hostScope?.mode === "selected") {
      return hostScope.workspaceIds.includes(workspace.workspaceId);
    }
    return true;
  });
}

function sessionIdOf(session: SessionFilterInput): string {
  return typeof session === "string" ? session : session.id;
}

function isRemoteSession(session: SessionFilterInput): boolean {
  if (typeof session === "string") return false;
  return (session.remote ?? session.projectionValues?.remoteHost ?? null) !== null;
}

/**
 * Filter flat-list sessions by the active host & workspace scope:
 * - Unfiltered: returns all sessions unchanged.
 * - Filtered: keeps sessions belonging to the visible workspaces, plus
 *   ungrouped local sessions only when `"local"` is included and in `mode: "all"`.
 */
export function filterSessionsByHostScope<T extends SessionFilterInput>(
  sessions: readonly T[],
  visibleWorkspaceIds: ReadonlySet<string> | readonly string[],
  workspaces: readonly WorkspaceView[],
  state: HostScopeFilterState,
): T[] {
  const effective = reconcileHostScopeFilter(state, workspaces);
  if (!isHostScopeFiltered(effective, workspaces)) return [...sessions];

  const visibleIds =
    visibleWorkspaceIds instanceof Set ? visibleWorkspaceIds : new Set(visibleWorkspaceIds);
  const allWorkspaceSessionIds = new Set<string>();
  const visibleWorkspaceSessionIds = new Set<string>();

  for (const workspace of workspaces) {
    const isVisible = visibleIds.has(workspace.workspaceId);
    for (const sessionId of workspace.sessionIds) {
      allWorkspaceSessionIds.add(sessionId);
      if (isVisible) visibleWorkspaceSessionIds.add(sessionId);
    }
  }

  const localIncluded = effective.selectedHost === "all" || effective.selectedHost === "local";
  const includeUngroupedLocal = localIncluded && effective.perHost["local"]?.mode !== "selected";

  return sessions.filter((session) => {
    const id = sessionIdOf(session);
    if (visibleWorkspaceSessionIds.has(id)) return true;
    if (!allWorkspaceSessionIds.has(id)) {
      return !isRemoteSession(session) && includeUngroupedLocal;
    }
    return false;
  });
}

/** Count how many of a host's current workspaces are selected under a subset scope. */
export function countSelectedWorkspacesForHost(
  host: HostSummary,
  scope: PerHostWorkspaceScope | undefined,
): number {
  if (scope === undefined || scope.mode !== "selected") return host.workspaceCount;
  const selected = new Set(scope.workspaceIds);
  let count = 0;
  for (const workspace of host.workspaces) {
    if (selected.has(workspace.workspaceId)) count += 1;
  }
  return count;
}

/** Switch the selected host filter target. */
export function selectHostScope(
  state: HostScopeFilterState,
  selectedHost: HostScopeTarget,
): HostScopeFilterState {
  if (state.selectedHost === selectedHost) return state;
  return {
    ...state,
    selectedHost,
  };
}

/**
 * Switch a host between `"all"` and `"selected"` workspace mode.
 * When entering `"selected"` for the first time on a host without a saved
 * subset, seed `workspaceIds` with `initialWorkspaceIds` so existing
 * workspaces stay checked until the user trims them.
 */
export function setHostWorkspaceScopeMode(
  state: HostScopeFilterState,
  hostKey: string,
  mode: "all" | "selected",
  initialWorkspaceIds: readonly string[],
): HostScopeFilterState {
  const existing = state.perHost[hostKey];
  const workspaceIds =
    mode === "selected"
      ? existing !== undefined
        ? [...existing.workspaceIds]
        : [...new Set(initialWorkspaceIds)]
      : existing !== undefined
        ? [...existing.workspaceIds]
        : [];
  return {
    ...state,
    perHost: {
      ...state.perHost,
      [hostKey]: { mode, workspaceIds },
    },
  };
}

/** Toggle one workspace ID in a host's `"selected"` workspace subset. */
export function toggleHostWorkspaceSelection(
  state: HostScopeFilterState,
  hostKey: string,
  workspaceId: string,
  allHostWorkspaceIds: readonly string[],
): HostScopeFilterState {
  const existing = state.perHost[hostKey];
  const baseIds = existing?.mode === "selected" ? existing.workspaceIds : [...allHostWorkspaceIds];
  const nextIds = baseIds.includes(workspaceId)
    ? baseIds.filter((id) => id !== workspaceId)
    : [...baseIds, workspaceId];
  return {
    ...state,
    perHost: {
      ...state.perHost,
      [hostKey]: {
        mode: "selected",
        workspaceIds: nextIds,
      },
    },
  };
}

/** Replace a host's `"selected"` workspace IDs (used by Select all / Clear). */
export function setHostSelectedWorkspaceIds(
  state: HostScopeFilterState,
  hostKey: string,
  workspaceIds: readonly string[],
): HostScopeFilterState {
  return {
    ...state,
    perHost: {
      ...state.perHost,
      [hostKey]: {
        mode: "selected",
        workspaceIds: [...new Set(workspaceIds)],
      },
    },
  };
}

/** Reset the filter back to showing all hosts and all workspaces. */
export function resetHostScopeFilter(): HostScopeFilterState {
  return { selectedHost: "all", perHost: {} };
}

/**
 * Ensure a target workspace (or ungrouped local session when `workspace` is
 * undefined) is visible under the active host scope filter without discarding
 * unrelated per-host preferences.
 */
export function ensureWorkspaceVisibleInHostScope(
  state: HostScopeFilterState,
  workspace: WorkspaceView | undefined,
  workspaces: readonly WorkspaceView[],
): HostScopeFilterState {
  const effective = reconcileHostScopeFilter(state, workspaces);
  const hostKey = workspace?.remote?.hostId ?? "local";
  let selectedHost = effective.selectedHost;
  let perHost = effective.perHost;
  let changed = false;

  if (selectedHost !== "all" && selectedHost !== hostKey) {
    selectedHost = "all";
    changed = true;
  }

  const hostScope = perHost[hostKey];
  if (hostScope?.mode === "selected") {
    if (workspace === undefined) {
      perHost = { ...perHost, [hostKey]: { ...hostScope, mode: "all" } };
      changed = true;
    } else if (!hostScope.workspaceIds.includes(workspace.workspaceId)) {
      perHost = {
        ...perHost,
        [hostKey]: {
          mode: "selected",
          workspaceIds: [...hostScope.workspaceIds, workspace.workspaceId],
        },
      };
      changed = true;
    }
  }

  return changed ? { selectedHost, perHost } : state;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate serialized filter JSON; never throws on corrupt input. */
export function parseHostScopeFilter(raw: string | null): HostScopeFilterState {
  if (raw === null || raw === "") return resetHostScopeFilter();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return resetHostScopeFilter();
    const selectedHost =
      typeof parsed.selectedHost === "string" && parsed.selectedHost.trim() !== ""
        ? parsed.selectedHost
        : "all";
    const perHost: Record<string, PerHostWorkspaceScope> = {};
    if (isPlainRecord(parsed.perHost)) {
      for (const [hostKey, entry] of Object.entries(parsed.perHost)) {
        if (hostKey === "" || !isPlainRecord(entry)) continue;
        if (entry.mode !== "all" && entry.mode !== "selected") continue;
        const workspaceIds = Array.isArray(entry.workspaceIds)
          ? [...new Set(entry.workspaceIds.filter((id): id is string => typeof id === "string"))]
          : [];
        perHost[hostKey] = {
          mode: entry.mode,
          workspaceIds,
        };
      }
    }
    return { selectedHost, perHost };
  } catch {
    return resetHostScopeFilter();
  }
}

/** Load persisted host scope filter state from localStorage safely. */
export function loadHostScopeFilter(
  storage?: Pick<Storage, "getItem"> | null,
): HostScopeFilterState {
  try {
    const target =
      storage !== undefined ? storage : typeof window !== "undefined" ? window.localStorage : null;
    if (target === null) return resetHostScopeFilter();
    return parseHostScopeFilter(target.getItem(HOST_SCOPE_FILTER_STORAGE_KEY));
  } catch {
    return resetHostScopeFilter();
  }
}

/** Persist host scope filter state to localStorage safely. */
export function saveHostScopeFilter(
  state: HostScopeFilterState,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target =
      storage !== undefined ? storage : typeof window !== "undefined" ? window.localStorage : null;
    if (target === null) return;
    target.setItem(HOST_SCOPE_FILTER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or privacy-mode failures.
  }
}
