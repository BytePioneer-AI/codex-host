/** Cross-package window event bridge shared between `ui-workspace` and `ui-codexhost`. */

export const OPEN_REMOTE_PEERS_SETTINGS_EVENT = "codexhost:open-remote-peers-settings";
export const OPEN_ADD_REMOTE_WORKSPACE_EVENT = "codexhost:open-add-remote-workspace";
export const REMOTE_PEERS_UPDATED_EVENT = "codexhost:remote-peers-updated";
export const REMOTE_WORKSPACE_CREATED_EVENT = "codexhost:remote-workspace-created";
export const APPLY_HOST_SCOPE_WORKSPACE_SELECTION_EVENT =
  "codexhost:apply-host-scope-workspace-selection";

const HOST_SCOPE_FILTER_STORAGE_KEY = "codexhost.sidebar.hostScopeFilter.v1";

export interface OpenAddRemoteWorkspaceDetail {
  hostId?: string;
}

export interface RemoteWorkspaceCreatedDetail {
  hostId: string;
  path: string;
  workspaceId?: string;
}

export interface RemotePeersUpdatedDetail {
  source?: unknown;
}

export interface ApplyHostScopeWorkspaceSelectionDetail {
  hostId: string;
  workspaceIds: string[];
}

export function dispatchOpenRemotePeersSettings(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_REMOTE_PEERS_SETTINGS_EVENT));
}

export function dispatchOpenAddRemoteWorkspace(hostId?: string): void {
  if (typeof window === "undefined") return;
  const detail: OpenAddRemoteWorkspaceDetail = hostId === undefined ? {} : { hostId };
  window.dispatchEvent(
    new CustomEvent<OpenAddRemoteWorkspaceDetail>(OPEN_ADD_REMOTE_WORKSPACE_EVENT, { detail }),
  );
}

export function dispatchRemotePeersUpdated(detail?: RemotePeersUpdatedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RemotePeersUpdatedDetail>(
      REMOTE_PEERS_UPDATED_EVENT,
      detail === undefined ? undefined : { detail },
    ),
  );
}

export function dispatchRemoteWorkspaceCreated(detail: RemoteWorkspaceCreatedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RemoteWorkspaceCreatedDetail>(REMOTE_WORKSPACE_CREATED_EVENT, { detail }),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Persist a newly-added host's selected workspace subset into the shared sidebar
 * host-scope filter storage and notify any mounted `WorkspaceBrowser` immediately.
 */
export function persistAndDispatchHostScopeWorkspaceSelection(
  hostId: string,
  workspaceIds: readonly string[],
): void {
  if (typeof window === "undefined" || hostId === "") return;
  const dedupedIds = [...new Set(workspaceIds)];
  try {
    const raw = window.localStorage.getItem(HOST_SCOPE_FILTER_STORAGE_KEY);
    let selectedHost = "all";
    const perHost: Record<string, { mode: "all" | "selected"; workspaceIds: string[] }> = {};
    if (raw !== null && raw !== "") {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        if (typeof parsed.selectedHost === "string" && parsed.selectedHost.trim() !== "") {
          selectedHost = parsed.selectedHost;
        }
        if (isPlainObject(parsed.perHost)) {
          for (const [key, entry] of Object.entries(parsed.perHost)) {
            if (key === "" || !isPlainObject(entry)) continue;
            if (entry.mode !== "all" && entry.mode !== "selected") continue;
            const ids = Array.isArray(entry.workspaceIds)
              ? [
                  ...new Set(
                    entry.workspaceIds.filter((id): id is string => typeof id === "string"),
                  ),
                ]
              : [];
            perHost[key] = { mode: entry.mode, workspaceIds: ids };
          }
        }
      }
    }
    perHost[hostId] = { mode: "selected", workspaceIds: dedupedIds };
    window.localStorage.setItem(
      HOST_SCOPE_FILTER_STORAGE_KEY,
      JSON.stringify({ selectedHost, perHost }),
    );
  } catch {
    // Ignore storage quota or privacy-mode failures.
  }
  window.dispatchEvent(
    new CustomEvent<ApplyHostScopeWorkspaceSelectionDetail>(
      APPLY_HOST_SCOPE_WORKSPACE_SELECTION_EVENT,
      { detail: { hostId, workspaceIds: dedupedIds } },
    ),
  );
}
