/** Addresses other devices can use to reach this server; they never carry a token. */
import { networkInterfaces } from "node:os";

import type { WebNetworkAccessUrl } from "@codexhost/shared-contracts";

/** Tailscale hands out CGNAT addresses (100.64.0.0/10): reachable from the phone on any network. */
function isTailscale(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/**
 * @param host - the listening address.
 * @param port - the listening port.
 * @returns Tailscale addresses first, then LAN; empty when the server listens only on this computer.
 */
export function networkAccessUrls(host: string, port: number): WebNetworkAccessUrl[] {
  const addresses = isWildcardHost(host)
    ? Object.values(networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .filter((entry) => entry.family === "IPv4" && !entry.internal)
        .map((entry) => entry.address)
    : isLoopbackHost(host)
      ? []
      : [host];
  return addresses
    .map((address) => ({
      kind: isTailscale(address) ? ("tailscale" as const) : ("lan" as const),
      url: `http://${address}:${String(port)}/`,
    }))
    .sort((a, b) => Number(b.kind === "tailscale") - Number(a.kind === "tailscale"));
}
