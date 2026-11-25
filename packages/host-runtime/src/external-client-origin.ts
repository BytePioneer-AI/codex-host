/**
 * An external client stands in for the parent Thread of the work it starts and
 * for the notified Thread of its watches. The identifier never names a real
 * Thread, so it cannot collide with one.
 */
const CLIENT_ORIGIN_PREFIX = "client:";
const PEER_ORIGIN_PREFIX = "peer:";

/** Synthetic parent identity assigned on B to Threads initiated by a remote peer. */
export const REMOTE_PEER_ORIGIN = `${PEER_ORIGIN_PREFIX}remote`;

/** Scoped synthetic parent identity for one authenticated Peer caller on B. */
export function peerOrigin(scope?: string): string {
  return scope ? `${PEER_ORIGIN_PREFIX}${scope}` : REMOTE_PEER_ORIGIN;
}

export function clientOrigin(name: string): string {
  return `${CLIENT_ORIGIN_PREFIX}${name}`;
}

/** The client name when the identifier is a client origin. */
export function originClientName(identifier: string | undefined): string | undefined {
  return identifier?.startsWith(CLIENT_ORIGIN_PREFIX)
    ? identifier.slice(CLIENT_ORIGIN_PREFIX.length)
    : undefined;
}

/** True when the identifier represents a remote-peer delegation origin rather than a local Thread. */
export function isPeerOrigin(identifier: string | undefined): boolean {
  return Boolean(identifier?.startsWith(PEER_ORIGIN_PREFIX));
}

/** True for any non-Thread synthetic origin (external client or remote peer). */
export function isSyntheticOrigin(identifier: string | undefined): boolean {
  return originClientName(identifier) !== undefined || isPeerOrigin(identifier);
}
