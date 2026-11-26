/** Ambient remote session chip (composer bottom toolbar left) and offline reconnect strip. */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import type {
  WorkspaceSource,
  WorkspaceView,
} from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  IconLoadingOutlineRegular,
  IconRefreshOutlineRegular,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { peerIdFromRemoteHostId, resolveRemotePeerColor } from "@codexhost/shared-contracts";
import { remotePeersApi } from "./api.ts";
import { dispatchRemotePeersUpdated } from "./remote-peers-events.ts";
import css from "./RemoteSessionBanner.module.css";

export interface RemoteSessionBannerFace {
  workspaces: WorkspaceSource;
}

type BannerProps = PropsRuntime<"conversation.input.notice"> &
  PropsLocale<"codexhostImport"> &
  RemoteSessionBannerFace;

type ChipProps = PropsRuntime<"conversation.input.left"> &
  PropsLocale<"codexhostImport"> &
  RemoteSessionBannerFace;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function RemoteGlobeIcon({ color }: { color: string }) {
  return (
    <span className={css.chipGlobe} data-color={color} aria-hidden="true">
      <svg viewBox="0 0 12 12" width="12.5" height="12.5" fill="none">
        <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.2" />
        <ellipse cx="6" cy="6" rx="2.1" ry="4.6" stroke="currentColor" strokeWidth="1.05" />
        <path d="M1.6 6h8.8" stroke="currentColor" strokeWidth="1.05" />
      </svg>
    </span>
  );
}

function useSessionWorkspace(
  workspaces: WorkspaceSource,
  sessionId: SessionId | undefined,
): WorkspaceView | undefined {
  return useSyncExternalStore(
    (listener) => workspaces.subscribe(listener),
    () =>
      sessionId === undefined
        ? undefined
        : workspaces.getSnapshot().items.find((item) => item.sessionIds.includes(sessionId)),
  );
}

/** Borderless minimal remote host indicator placed in `conversation.input.left` when online. */
export function RemoteSessionChip({ sessionId, workspaces }: ChipProps): ReactNode {
  const workspace = useSessionWorkspace(workspaces, sessionId);
  const remote = workspace?.remote;
  if (workspace === undefined || remote === undefined || remote.state !== "connected") {
    return null;
  }

  const remoteColor = resolveRemotePeerColor(remote.hostId, remote.color);
  const fullLocation = workspace.path
    ? `${remote.displayName} · ${workspace.path}`
    : remote.displayName;

  return (
    <Tooltip label={fullLocation} side="top" delayMs={350}>
      <span
        className={css.chip}
        data-remote-chip
        data-remote-state={remote.state}
        tabIndex={0}
        role="status"
        aria-label={fullLocation}
      >
        <RemoteGlobeIcon color={remoteColor} />
        <span className={css.chipHost}>{remote.displayName}</span>
      </span>
    </Tooltip>
  );
}

/** Slim reconnect notice rendered in `conversation.input.notice` only while disconnected. */
export function RemoteSessionBanner({ sessionId, workspaces, t }: BannerProps): ReactNode {
  const workspace = useSessionWorkspace(workspaces, sessionId);
  const [reconnectingPeerId, setReconnectingPeerId] = useState<string | null>(null);
  const [reconnectError, setReconnectError] = useState<{ peerId: string; message: string } | null>(
    null,
  );

  const remote = workspace?.remote;
  if (workspace === undefined || remote === undefined || remote.state === "connected") {
    return null;
  }

  const peerId = peerIdFromRemoteHostId(remote.hostId);
  const reconnecting = peerId !== undefined && reconnectingPeerId === peerId;
  const currentError =
    peerId !== undefined && reconnectError?.peerId === peerId ? reconnectError.message : null;

  const handleReconnect = async (): Promise<void> => {
    if (peerId === undefined || reconnecting) return;
    const activePeerId = peerId;
    setReconnectingPeerId(activePeerId);
    setReconnectError((current) => (current?.peerId === activePeerId ? null : current));
    try {
      await remotePeersApi.reconnect(activePeerId);
      dispatchRemotePeersUpdated();
    } catch (cause) {
      setReconnectError({ peerId: activePeerId, message: messageOf(cause) });
    } finally {
      setReconnectingPeerId((current) => (current === activePeerId ? null : current));
    }
  };

  return (
    <div className={css.strip} data-remote-state={remote.state} role="alert">
      <div className={css.stripLead}>
        <span className={css.dot} data-state={remote.state} aria-hidden="true" />
        <span className={css.stripText}>
          {currentError !== null
            ? t("remoteSession.reconnectFailed", { message: currentError })
            : t("remoteSession.disconnectedStrip", { name: remote.displayName })}
        </span>
      </div>
      {peerId !== undefined && (
        <button
          type="button"
          className={css.reconnectBtn}
          disabled={reconnecting}
          aria-busy={reconnecting}
          onClick={() => void handleReconnect()}
        >
          {reconnecting ? (
            <span className={css.spinner}>
              <IconLoadingOutlineRegular size={12} />
            </span>
          ) : (
            <IconRefreshOutlineRegular size={12} />
          )}
          <span>{t(reconnecting ? "remoteSession.reconnecting" : "remoteSession.reconnect")}</span>
        </button>
      )}
    </div>
  );
}
