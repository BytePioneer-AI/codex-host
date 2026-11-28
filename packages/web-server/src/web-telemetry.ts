/**
 * Zero-ID Web-side product telemetry classifier.
 *
 * Classifies only coarse Web surface types (`web` / `web-mobile` / `web-desktop-shell`) and
 * active remote access transport categories (`official-relay`, `self-hosted-relay`, Tailscale,
 * LAN, reverse proxy, or remote peer) when an authenticated connection occurs.
 *
 * Privacy boundary:
 * - Never records or forwards client IP addresses, self-hosted Relay domains, access tokens,
 *   cookies, request paths, unused local configuration, or conversation content.
 * - Forwards only coarse enum tags to the local Host's zero-ID `HostProductTelemetry`, where
 *   all daily deduplication happens locally before any aggregate counter increment is sent.
 * - Disable anytime via `CODEXHOST_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `CODEXHOST_TELEMETRY_URL=off`.
 *   See `docs/product/product-telemetry.md` and `docs/PRIVACY.md`.
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type {
  ProductTelemetrySignalParams,
  TelemetryRemoteAccessChannel,
  TelemetrySurface,
  WebRelayKind,
} from "@codexhost/shared-contracts";
import { isLocalConnection, type RequestTrust } from "./request-trust.ts";

const FLUSH_DEBOUNCE_MS = 20_000;

function normalizedAddress(address: string | undefined): string {
  const value = (address ?? "").trim().toLowerCase();
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
}

function isTailscaleIp(address: string): boolean {
  const clean = normalizedAddress(address).split("%")[0] ?? "";
  const family = isIP(clean);
  if (family === 4) {
    const [first, second] = clean.split(".").map(Number);
    return first === 100 && second !== undefined && second >= 64 && second <= 127;
  }
  if (family === 6) {
    try {
      return new URL(`http://[${clean}]`).hostname.startsWith("[fd7a:115c:a1e0:");
    } catch {
      return false;
    }
  }
  return false;
}

function lastHeaderValue(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value.join(",") : value;
  const last = text?.split(",").at(-1)?.trim();
  return last === undefined || last === "" ? undefined : last;
}

/**
 * Classifies an authenticated incoming Web request's remote access channel without recording
 * IP addresses, hostnames, or credentials. Returns `null` for direct local loopback access.
 */
export function classifyRemoteAccessChannel(
  request: IncomingMessage,
  trust: RequestTrust,
  activeRelayKind: WebRelayKind,
): TelemetryRemoteAccessChannel | null {
  if (isLocalConnection(request)) return null;
  if (trust.relaySockets.has(request.socket)) {
    return activeRelayKind === "self-hosted" ? "self-hosted-relay" : "official-relay";
  }
  if (trust.isExplicitTrustedProxy(request)) {
    return "custom-proxy";
  }
  const peer = normalizedAddress(request.socket.remoteAddress);
  if (trust.trustLoopback && isLoopbackAddress(peer)) {
    const forwardedClient = lastHeaderValue(request.headers["x-forwarded-for"]);
    if (forwardedClient && isTailscaleIp(forwardedClient)) {
      return "tailscale-serve";
    }
    return "tailscale-funnel";
  }
  if (isTailscaleIp(peer)) {
    return "tailscale-ip";
  }
  return "lan";
}

export function classifyWebSurface(request: IncomingMessage): TelemetrySurface {
  const ua = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "";
  if (/CodexHostDesktop|CodexHostShell|Electron\//iu.test(ua)) {
    return "web-desktop-shell";
  }
  if (/iPhone|iPad|iPod|Android|Mobile/iu.test(ua)) {
    return "web-mobile";
  }
  return "web";
}

export interface WebProductTelemetryOptions {
  send: (signal: ProductTelemetrySignalParams) => Promise<unknown> | undefined;
  debounceMs?: number;
}

/**
 * Batches coarse Web-side surfaces and active remote access channels, forwarding them to
 * the local shared Host's zero-ID `HostProductTelemetry` instance.
 */
export class WebProductTelemetry {
  readonly #send: WebProductTelemetryOptions["send"];
  readonly #debounceMs: number;

  readonly #pendingSurfaces = new Set<TelemetrySurface>();
  readonly #pendingRemoteAccess = new Set<TelemetryRemoteAccessChannel>();

  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: WebProductTelemetryOptions) {
    this.#send = options.send;
    this.#debounceMs = options.debounceMs ?? FLUSH_DEBOUNCE_MS;
  }

  observeAuthenticatedHttp(
    request: IncomingMessage,
    pathname: string,
    trust: RequestTrust,
    activeRelayKind: WebRelayKind,
  ): void {
    if (this.#closed) return;
    if (pathname.startsWith("/api/peer/v1/")) {
      const channel = classifyRemoteAccessChannel(request, trust, activeRelayKind);
      this.#pendingRemoteAccess.add("remote-peer");
      if (channel) this.#pendingRemoteAccess.add(channel);
      this.#schedule();
      return;
    }

    if (pathname === "/" || pathname === "/index.html" || pathname === "/api/auth/login") {
      this.#pendingSurfaces.add(classifyWebSurface(request));
      const channel = classifyRemoteAccessChannel(request, trust, activeRelayKind);
      if (channel) {
        this.#pendingRemoteAccess.add(channel);
      }
      this.#schedule();
    }
  }

  observeAuthenticatedUpgrade(
    request: IncomingMessage,
    trust: RequestTrust,
    activeRelayKind: WebRelayKind,
  ): void {
    if (this.#closed) return;
    this.#pendingSurfaces.add(classifyWebSurface(request));
    const channel = classifyRemoteAccessChannel(request, trust, activeRelayKind);
    if (channel) {
      this.#pendingRemoteAccess.add(channel);
    }
    this.#schedule();
  }

  async flushNow(): Promise<void> {
    if (this.#closed) return;
    const signal: ProductTelemetrySignalParams = {};
    if (this.#pendingSurfaces.size > 0) signal.surfaces = [...this.#pendingSurfaces];
    if (this.#pendingRemoteAccess.size > 0) signal.remoteAccess = [...this.#pendingRemoteAccess];
    if (Object.keys(signal).length === 0) return;

    this.#pendingSurfaces.clear();
    this.#pendingRemoteAccess.clear();

    try {
      await this.#send(signal);
    } catch {
      // Telemetry is strictly best-effort and must never affect Web operation.
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #schedule(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flushNow();
    }, this.#debounceMs);
    this.#timer.unref();
  }
}
