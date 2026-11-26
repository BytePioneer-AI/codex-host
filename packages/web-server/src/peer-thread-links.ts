/** Pure perspective translation for `thread://<id>?hostId=<hostId>` links across paired Peers. */
import { peerIdFromRemoteHostId } from "@codexhost/shared-contracts";

/**
 * Matches `thread://<encodedId>?hostId=<encodedHostId>` inside prose or Markdown links
 * without swallowing surrounding Markdown delimiters or sentence punctuation.
 */
const THREAD_HOST_LINK_RE =
  /(?<![\w:/])thread:\/\/([^/?#\s<>()[\]`"'，。！？；：、]+)\?hostId=([^\s<>()[\]`"'，。！？；：、]+(?<![.,;]))/gu;

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

/**
 * Translate Hub A-perspective `thread://...?hostId=...` links into Peer B's perspective:
 * 1. Links targeting B itself (by `targetHostId` or matching `targetNodeId`) become `hostId=local`.
 * 2. Links targeting A (`local`) or another Peer C whose nodeId appears in B's `peerNodes` become
 *    B's corresponding `remote-peer:<peerX_on_B>`.
 * 3. Desktop SSH/control links, unknown hosts, or nodes B has not paired remain verbatim.
 */
export function translateThreadLinksForPeer(
  text: string,
  context: PeerOutboundLinkContext,
): string {
  return rewriteThreadHostLinks(text, (hostId) => {
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
  });
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
  return rewriteThreadHostLinks(text, (hostId) => {
    if (peerIdFromRemoteHostId(hostId) === undefined) return undefined;
    if (!Object.hasOwn(peerNodes, hostId)) return undefined;
    const nodeId = peerNodes[hostId];
    if (!nodeId) return undefined;
    return context.hostIdForNodeId(nodeId);
  });
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
