/** Human-readable access details printed after main.ts emits the local readiness link. */
import type { WebNetworkAccessUrl } from "@codexhost/shared-contracts";

const KIND_LABEL: Record<WebNetworkAccessUrl["kind"], string> = {
  public: "Public",
  relay: "Relay",
  "tailscale-funnel": "Funnel (public)",
  "tailscale-https": "Tailscale HTTPS",
  tailscale: "Tailscale",
  lan: "LAN",
  virtual: "Virtual",
};

export function formatWebStartup(options: {
  networkUrls: readonly WebNetworkAccessUrl[];
  qrCode?: string;
  /** The server does not listen on a local address, so the access token cannot be viewed. */
  localManagementUnavailable?: boolean;
}): string {
  const lines: string[] = [];
  if (options.networkUrls.length > 0) {
    lines.push("", "Network access");
    for (const entry of options.networkUrls) {
      lines.push(`${`${KIND_LABEL[entry.kind]}:`.padEnd(15)}${entry.url}`);
    }
    lines.push(
      "These addresses need the access token: scan its QR code on this computer in Settings → Connect devices.",
    );
    if (options.networkUrls.some((entry) => entry.url.startsWith("http:"))) {
      lines.push("HTTP on these addresses is not encrypted; use them only on networks you trust.");
    }
    if (options.networkUrls.some((entry) => entry.kind === "tailscale-funnel")) {
      lines.push(
        "Funnel is public: anyone on the Internet can reach the sign-in page; an access token is still required.",
      );
    }
  }
  const preferred = options.networkUrls[0];
  if (preferred && options.qrCode !== undefined) {
    lines.push(
      "",
      `Phone access · ${KIND_LABEL[preferred.kind]}`,
      preferred.kind === "tailscale" || preferred.kind === "tailscale-https"
        ? "Connect both devices to Tailscale, then scan."
        : preferred.kind === "public" || preferred.kind === "tailscale-funnel"
          ? "Scan to open the configured address."
          : "Connect your phone to the same Wi-Fi, then scan.",
      "",
      options.qrCode.trimEnd(),
    );
  }
  if (options.localManagementUnavailable === true) {
    lines.push(
      "",
      "This address is not this computer's local address, so the access token cannot be viewed here.",
      "Listen on 127.0.0.1 or 0.0.0.0 to view it.",
    );
  }
  lines.push("", "Keep access links private.", "");
  return lines.join("\n");
}
