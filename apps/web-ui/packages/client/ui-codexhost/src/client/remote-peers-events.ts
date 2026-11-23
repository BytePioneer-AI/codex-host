/** Cross-package window event bridge shared between `ui-workspace` and `ui-codexhost`. */

export const OPEN_REMOTE_PEERS_SETTINGS_EVENT = "codexhost:open-remote-peers-settings";
export const OPEN_ADD_REMOTE_WORKSPACE_EVENT = "codexhost:open-add-remote-workspace";
export const REMOTE_PEERS_UPDATED_EVENT = "codexhost:remote-peers-updated";

export interface OpenAddRemoteWorkspaceDetail {
  hostId?: string;
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

export function dispatchRemotePeersUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(REMOTE_PEERS_UPDATED_EVENT));
}
