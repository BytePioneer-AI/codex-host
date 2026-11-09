/**
 * What one HTTP request may claim about where it came from.
 *
 * `x-forwarded-*` is client-controlled unless the direct peer is a trusted proxy.
 * Local access is stricter: any sign of forwarding makes a request non-local, even from a trusted
 * proxy, because a tunnel ending on the loopback interface is not this computer.
 */
import { isIP, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";

function normalizedAddress(address: string | undefined): string {
  const value = (address ?? "").trim().toLowerCase();
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
}

/** The rightmost value is the one the adjacent proxy wrote; earlier ones are the client's claim. */
function lastHeaderValue(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value.join(",") : value;
  const last = text?.split(",").at(-1)?.trim();
  return last === undefined || last === "" ? undefined : last;
}

/**
 * Whether this request reached the server directly from this computer through a local address.
 * @param request - the request; its socket's local port is the listening port.
 */
export function isLocalConnection(request: IncomingMessage): boolean {
  const address = normalizedAddress(request.socket.remoteAddress);
  if (!isLoopbackAddress(address)) return false;
  const forwarded = Object.keys(request.headers).some(
    (name) => name === "forwarded" || name.startsWith("x-forwarded-"),
  );
  if (forwarded) return false;
  try {
    const { hostname, port } = new URL(`http://${request.headers.host ?? ""}`);
    return (
      (hostname === "127.0.0.1" || hostname === "localhost") &&
      Number(port || 80) === request.socket.localPort
    );
  } catch {
    return false;
  }
}

export class RequestTrust {
  private readonly proxies: ReadonlySet<string>;
  trustLoopback = false;
  readonly relaySockets = new WeakMap<
    Socket,
    {
      address: string;
      origin: string;
      authenticated?: () => void;
    }
  >();

  /** Notify only the relay connection bound by the TLS bridge, never client-provided headers. */
  authenticated(request: IncomingMessage): void {
    try {
      this.relaySockets.get(request.socket)?.authenticated?.();
    } catch {
      // Authentication is authoritative; optional telemetry must not block access.
    }
  }

  /** @param trustedProxies - comma-separated IP addresses of proxies allowed to set forwarding headers. */
  constructor(trustedProxies: string | undefined) {
    const addresses = (trustedProxies ?? "")
      .split(",")
      .map((address) => address.trim())
      .filter((address) => address !== "");
    for (const address of addresses) {
      if (isIP(address) === 0) throw new Error(`--trusted-proxy: ${address} is not an IP address`);
    }
    this.proxies = new Set(addresses.map(normalizedAddress));
  }

  private fromTrustedProxy(request: IncomingMessage): boolean {
    const address = normalizedAddress(request.socket.remoteAddress);
    return this.proxies.has(address) || (this.trustLoopback && isLoopbackAddress(address));
  }

  /** The address failed sign-ins are counted against. */
  clientAddress(request: IncomingMessage): string {
    const relay = this.relaySockets.get(request.socket);
    if (relay !== undefined) return relay.address;
    const forwarded = this.fromTrustedProxy(request)
      ? lastHeaderValue(request.headers["x-forwarded-for"])
      : undefined;
    return forwarded ?? normalizedAddress(request.socket.remoteAddress);
  }

  /** Whether the browser reached this server over HTTPS, as far as can be trusted. */
  secure(request: IncomingMessage): boolean {
    if (this.relaySockets.has(request.socket)) return true;
    return (
      this.fromTrustedProxy(request) &&
      lastHeaderValue(request.headers["x-forwarded-proto"]) === "https"
    );
  }

  /**
   * Reject cross-origin browser requests (CSRF / cross-site WebSocket hijacking). Requests without
   * an Origin header (native clients, curl) are allowed; they still need an access token.
   */
  sameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined || origin === "null") return origin === undefined;
    const relay = this.relaySockets.get(request.socket);
    if (relay !== undefined) return origin === relay.origin;
    const forwardedHost = this.fromTrustedProxy(request)
      ? lastHeaderValue(request.headers["x-forwarded-host"])
      : undefined;
    try {
      return new URL(origin).host === (forwardedHost ?? request.headers.host);
    } catch {
      return false;
    }
  }
}
