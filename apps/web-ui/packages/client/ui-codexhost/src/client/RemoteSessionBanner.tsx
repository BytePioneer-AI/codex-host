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
import { peerIdFromRemoteHostId } from "@codexhost/shared-contracts";
import { remotePeersApi } from "./api.ts";
import { dispatchRemotePeersUpdated } from "./remote-peers-events.ts";
import { RemoteHostIcon } from "./RemoteHostIcon.tsx";
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

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  if (!trimmed) return path;
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash === -1 ? trimmed : trimmed.slice(slash + 1) || trimmed;
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

/** Borderless ambient chip placed in `conversation.input.left` when a remote session is online. */
export function RemoteSessionChip({ sessionId, workspaces, t }: ChipProps): ReactNode {
  const workspace = useSessionWorkspace(workspaces, sessionId);
  const remote = workspace?.remote;
  if (workspace === undefined || remote === undefined || remote.state !== "connected") {
    return null;
  }

  const folderName = workspace.title || basenameOf(workspace.path);
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
        <RemoteHostIcon size={12} className={css.hostIcon} />
        <span className={css.chipHost}>{remote.displayName}</span>
        {folderName !== "" && (
          <>
            <span className={css.chipSep} aria-hidden="true">
              ·
            </span>
            <span className={css.chipWorkspace}>{folderName}</span>
          </>
        )}
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
