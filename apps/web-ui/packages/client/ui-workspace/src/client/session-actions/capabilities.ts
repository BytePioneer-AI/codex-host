/** Session-level pin and fork eligibility derived from existing remoteHost metadata. */
import { REMOTE_PEER_HOST_ID_PREFIX } from "@codexhost/shared-contracts";
import type { SessionSummary } from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "../tree.ts";

type SessionRemoteLike = Pick<SessionSummary, "id" | "projectionValues">;

function remoteHostIdOf(session: SessionRemoteLike | undefined): string | undefined {
  return session?.projectionValues?.remoteHost?.hostId;
}

/** Whether a Session belongs to any remote Host (Peer or Codex Desktop remote connection). */
export function isRemoteSessionSummary(session: SessionRemoteLike | undefined): boolean {
  if (session === undefined) return false;
  return remoteHostIdOf(session) !== undefined || String(session.id).startsWith("web-remote:");
}

/**
 * Whether a Session supports pinning from the sidebar:
 * - Local Sessions: supported.
 * - Remote Peer (`remote-peer:*`) Sessions: supported (forwarded & synced with Peer Host).
 * - Non-Peer remote connections (e.g. `remote-ssh*`, `remote-control:*`): unsupported.
 */
export function canPinSession(session: SessionRemoteLike | undefined): boolean {
  if (session === undefined) return false;
  const hostId = remoteHostIdOf(session);
  if (hostId !== undefined) {
    return hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX);
  }
  return !String(session.id).startsWith("web-remote:");
}

/**
 * Whether a Session supports forking from the sidebar or keyboard shortcut.
 * Remote Sessions do not support `session/fork`.
 */
export function canForkSession(session: SessionRemoteLike | undefined): boolean {
  if (session === undefined) return false;
  return !isRemoteSessionSummary(session);
}

/**
 * Whether a Session supports deleting from the sidebar:
 * - Local Sessions and Remote Peer (`remote-peer:*`) Sessions: supported.
 * - Non-Peer remote connections (e.g. `remote-ssh*`, `remote-control:*`): unsupported.
 */
export function canDeleteSession(session: SessionRemoteLike | undefined): boolean {
  return canPinSession(session);
}
