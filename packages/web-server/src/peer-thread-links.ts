/** Pure perspective translation for `thread://...?hostId=...` and `subagent://codexhost-remote/...` links across paired Peers. */
import {
  DELEGATION_MENTION_PATH_PREFIX,
  REMOTE_DELEGATION_MENTION_PATH_PREFIX,
  peerIdFromRemoteHostId,
} from "@codexhost/shared-contracts";

/**
 * Matches `thread://<encodedId>?hostId=<encodedHostId>` inside prose or Markdown links
 * without swallowing surrounding Markdown delimiters or sentence punctuation.
 */
const THREAD_HOST_LINK_RE =
  /(?<![\w:/])thread:\/\/([^/?#\s<>()[\]`"'，。！？；：、]+)\?hostId=([^\s<>()[\]`"'，。！？；：、]+(?<![.,;]))/gu;

const REMOTE_DELEGATION_LINK_RE =
  /\[@([^\]\n]+)\]\((<)?subagent:\/\/codexhost-remote\/([A-Za-z0-9_%-]+)(?:\/([a-z0-9][a-z0-9-]*))?(>)?\)/gu;

export interface PeerOutboundLinkContext {
  /** Target Peer's hostId in the sender's (Hub A) perspective (`remote-peer:<peerB_on_A>`). */
  targetHostId: string;
  /** Target Peer's advertised stable nodeId, when known. */
  targetNodeId?: string | undefined;
  /** Target Peer's anonymous `remote-peer:<peerX_on_B> -> nodeId` map from its manifest. */
  targetPeerNodes?: Readonly<Record<string, string>> | undefined;
  /** Resolve a sender-side hostId (`local` or `remote-peer:*`) to its stable nodeId. */
  nodeIdForHostId?: ((hostId: string) => string | undefined) | undefined;
}

export interface PeerInboundLinkContext {
  /** Source Peer's anonymous `remote-peer:<peerX_on_B> -> nodeId` map from its manifest. */
  sourcePeerNodes?: Readonly<Record<string, string>> | undefined;
  /** Resolve a stable nodeId to the viewer's (Hub A) hostId (`local` or `remote-peer:*`). */
  hostIdForNodeId: (nodeId: string) => string | undefined;
}

function isValidLinkSegment(encoded: string): boolean {
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 && !/[\u0000-\u001f\u007f]/u.test(decoded);
  } catch {
    return false;
  }
}

function rewriteThreadHostLinks(
  text: string,
  mapHostId: (decodedHostId: string) => string | undefined,
): string {
  if (!text.includes("thread://")) return text;
  return text.replace(
    THREAD_HOST_LINK_RE,
    (fullMatch, rawThreadId: string, rawHostId: string): string => {
      if (/[&#?]/u.test(rawHostId) || !isValidLinkSegment(rawThreadId)) return fullMatch;
      let decodedHostId: string;
      try {
        decodedHostId = decodeURIComponent(rawHostId);
      } catch {
        return fullMatch;
      }
      if (!decodedHostId || /[\u0000-\u001f\u007f]/u.test(decodedHostId)) return fullMatch;
      const mapped = mapHostId(decodedHostId);
      if (!mapped || mapped === decodedHostId) return fullMatch;
      return `thread://${rawThreadId}?hostId=${encodeURIComponent(mapped)}`;
    },
  );
}

function rewriteRemoteDelegationLinks(
  text: string,
  mapHostId: (decodedHostId: string) => string | undefined,
  collapseLocalWithHarness: boolean,
): string {
  if (!text.includes(REMOTE_DELEGATION_MENTION_PATH_PREFIX)) return text;
  return text.replace(
    REMOTE_DELEGATION_LINK_RE,
    (
      fullMatch,
      label: string,
      openAngle: string | undefined,
      rawHostId: string,
      harnessId: string | undefined,
      closeAngle: string | undefined,
    ): string => {
      if (Boolean(openAngle) !== Boolean(closeAngle)) return fullMatch;
      let decodedHostId: string;
      try {
        decodedHostId = decodeURIComponent(rawHostId);
      } catch {
        return fullMatch;
      }
      if (decodedHostId !== "local" && peerIdFromRemoteHostId(decodedHostId) === undefined) {
        return fullMatch;
      }
      const mapped = mapHostId(decodedHostId);
      if (!mapped || mapped === decodedHostId) return fullMatch;
      const open = openAngle ?? "";
      const close = closeAngle ?? "";
      if (collapseLocalWithHarness && mapped === "local" && harnessId !== undefined) {
        return `[@${label}](${open}${DELEGATION_MENTION_PATH_PREFIX}${harnessId}${close})`;
      }
      const path =
        harnessId === undefined
          ? `${REMOTE_DELEGATION_MENTION_PATH_PREFIX}${encodeURIComponent(mapped)}`
          : `${REMOTE_DELEGATION_MENTION_PATH_PREFIX}${encodeURIComponent(mapped)}/${harnessId}`;
      return `[@${label}](${open}${path}${close})`;
    },
  );
}

/**
 * Translate Hub A-perspective `thread://...?hostId=...` and `subagent://codexhost-remote/...`
 * links into Peer B's perspective:
 * 1. Links targeting B itself (by `targetHostId` or matching `targetNodeId`) become `hostId=local`
 *    (or `subagent://codexhost.<harnessId>` for remote delegation mentions that carry a Harness).
 * 2. Links targeting A (`local`) or another Peer C whose nodeId appears in B's `peerNodes` become
 *    B's corresponding `remote-peer:<peerX_on_B>`.
 * 3. Desktop SSH/control links, unknown hosts, or nodes B has not paired remain verbatim.
 */
export function translateThreadLinksForPeer(
  text: string,
  context: PeerOutboundLinkContext,
): string {
  const mapHostId = (hostId: string): string | undefined => {
    if (hostId !== "local" && peerIdFromRemoteHostId(hostId) === undefined) return undefined;
    if (hostId === context.targetHostId) return "local";
    const sourceNodeId = context.nodeIdForHostId?.(hostId);
    if (!sourceNodeId) return undefined;
    if (context.targetNodeId !== undefined && sourceNodeId === context.targetNodeId) {
      return "local";
    }
    if (!context.targetPeerNodes) return undefined;
    for (const [peerHostId, peerNodeId] of Object.entries(context.targetPeerNodes)) {
      if (peerNodeId === sourceNodeId && peerIdFromRemoteHostId(peerHostId) !== undefined) {
        return peerHostId;
      }
    }
    return undefined;
  };
  const withThreads = rewriteThreadHostLinks(text, mapHostId);
  return rewriteRemoteDelegationLinks(withThreads, mapHostId, true);
}

/**
 * Unambiguously restore Peer B-perspective `remote-peer:*` links in projected history back to
 * Hub A's perspective using B's `peerNodes` and A's known nodeIds.
 *
 * `hostId=local` is intentionally left untouched on readback: when B has not paired A (or before
 * mutual pairing was established), A's `hostId=local` links land verbatim on B, so rewriting
 * `hostId=local` to B would corrupt A's own references.
 */
export function translateThreadLinksFromPeer(
  text: string,
  context: PeerInboundLinkContext,
): string {
  const peerNodes = context.sourcePeerNodes;
  if (!peerNodes) return text;
  const mapHostId = (hostId: string): string | undefined => {
    if (peerIdFromRemoteHostId(hostId) === undefined) return undefined;
    if (!Object.hasOwn(peerNodes, hostId)) return undefined;
    const nodeId = peerNodes[hostId];
    if (!nodeId) return undefined;
    return context.hostIdForNodeId(nodeId);
  };
  const withThreads = rewriteThreadHostLinks(text, mapHostId);
  return rewriteRemoteDelegationLinks(withThreads, mapHostId, false);
}

/** Map `text` fields on content part arrays without mutating inputs or touching non-text parts. */
export function translateContentTextParts<T>(
  content: readonly T[],
  translate: (text: string) => string,
): T[] {
  let changed = false;
  const next = content.map((part) => {
    if (part !== null && typeof part === "object" && !Array.isArray(part)) {
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        const rewritten = translate(record.text);
        if (rewritten !== record.text) {
          changed = true;
          return { ...record, text: rewritten } as T;
        }
      }
    }
    return part;
  });
  return changed ? next : [...content];
}
