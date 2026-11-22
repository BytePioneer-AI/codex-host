/** Addresses other devices can use to reach this server; they never carry a token. */
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import type { WebNetworkAccessUrl } from "@codexhost/shared-contracts";

/** Tailscale hands out CGNAT addresses (100.64.0.0/10): reachable from the phone on any network. */
function isTailscale(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** Host-side ends of VM and container networks; macOS names VM and Internet Sharing bridges `bridge*`. */
const VIRTUAL_INTERFACE =
  /^(?:docker|br-|virbr|vmnet|vboxnet|veth|lxcbr|cni|flannel|cali|bridge)|^vEthernet \((?:Default Switch|WSL)|VMware Network Adapter|VirtualBox Host-Only/u;

const KIND_ORDER = { tailscale: 0, lan: 1, virtual: 2 };

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function kindOf(address: string, interfaceName: string | undefined): keyof typeof KIND_ORDER {
  if (isTailscale(address)) return "tailscale";
  return interfaceName !== undefined && VIRTUAL_INTERFACE.test(interfaceName) ? "virtual" : "lan";
}

/**
 * @param host - the listening address.
 * @param port - the listening port.
 * @param interfaces - the machine's network interfaces.
 * @returns Tailscale addresses, then LAN, then virtual; empty when the server listens only on this computer.
 */
export function networkAccessUrls(
  host: string,
  port: number,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): WebNetworkAccessUrl[] {
  const addresses: Array<{ address: string; name?: string }> = isWildcardHost(host)
    ? Object.entries(interfaces).flatMap(([name, entries]) =>
        (entries ?? [])
          .filter((entry) => entry.family === "IPv4" && !entry.internal)
          .map((entry) => ({ address: entry.address, name })),
      )
    : isLoopbackHost(host)
      ? []
      : [{ address: host }];
  return addresses
    .map(({ address, name }) => ({
      kind: kindOf(address, name),
      url: `http://${address}:${String(port)}/`,
    }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** @returns the addresses worth printing: virtual ones only when nothing else is available. */
export function reachableNetworkUrls(urls: WebNetworkAccessUrl[]): WebNetworkAccessUrl[] {
  const reachable = urls.filter((entry) => entry.kind !== "virtual");
  return reachable.length > 0 ? reachable : urls;
}
