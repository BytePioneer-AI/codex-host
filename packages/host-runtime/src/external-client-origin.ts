/**
 * An external client stands in for the parent Thread of the work it starts and
 * for the notified Thread of its watches. The identifier never names a real
 * Thread, so it cannot collide with one.
 */
const CLIENT_ORIGIN_PREFIX = "client:";

export function clientOrigin(name: string): string {
  return `${CLIENT_ORIGIN_PREFIX}${name}`;
}

/** The client name when the identifier is a client origin. */
export function originClientName(identifier: string | undefined): string | undefined {
  return identifier?.startsWith(CLIENT_ORIGIN_PREFIX)
    ? identifier.slice(CLIENT_ORIGIN_PREFIX.length)
    : undefined;
}
