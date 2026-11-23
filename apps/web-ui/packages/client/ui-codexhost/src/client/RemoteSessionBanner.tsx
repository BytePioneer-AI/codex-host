/** Compact remote session identity and reconnect notice above the composer. */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { WorkspaceSource } from "@deepseek-ai/dsh-api-workspace-controller/client";
import {
  IconLoadingOutlineRegular,
  IconRefreshOutlineRegular,
  PathLabel,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { peerIdFromRemoteHostId } from "@codexhost/shared-contracts";
import { remotePeersApi } from "./api.ts";
import { dispatchRemotePeersUpdated } from "./remote-peers-events.ts";
import css from "./RemoteSessionBanner.module.css";

export interface RemoteSessionBannerFace {
  workspaces: WorkspaceSource;
}

type Props = PropsRuntime<"conversation.input.notice"> &
  PropsLocale<"codexhostImport"> &
  RemoteSessionBannerFace;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function RemoteSessionBanner({ sessionId, workspaces, t }: Props): ReactNode {
  const workspace = useSyncExternalStore(
    (listener) => workspaces.subscribe(listener),
    () =>
      sessionId === undefined
        ? undefined
        : workspaces.getSnapshot().items.find((item) => item.sessionIds.includes(sessionId)),
  );
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  const remote = workspace?.remote;
  if (workspace === undefined || remote === undefined) return null;

  const connected = remote.state === "connected";
  const peerId = peerIdFromRemoteHostId(remote.hostId);

  const handleReconnect = async (): Promise<void> => {
    if (peerId === undefined || reconnecting) return;
    setReconnecting(true);
    setReconnectError(null);
    try {
      await remotePeersApi.reconnect(peerId);
      dispatchRemotePeersUpdated();
    } catch (cause) {
      setReconnectError(messageOf(cause));
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div
      className={css.banner}
      data-remote-state={remote.state}
      role={connected ? "status" : "alert"}
    >
      <div className={css.identity}>
        <span className={css.dot} data-state={remote.state} aria-hidden="true" />
        <span className={css.host}>
          {t("remoteSession.identity", { name: remote.displayName })}
        </span>
        <span className={css.sep} aria-hidden="true">
          ·
        </span>
        <PathLabel path={workspace.path} className={css.path} />
      </div>
      {!connected && (
        <div className={css.disconnectedRow}>
          <span className={css.disconnectedText}>
            {reconnectError !== null
              ? t("remoteSession.reconnectFailed", { message: reconnectError })
              : t("remoteSession.disconnected")}
          </span>
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
              <span>
                {t(reconnecting ? "remoteSession.reconnecting" : "remoteSession.reconnect")}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
