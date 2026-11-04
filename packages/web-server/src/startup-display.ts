/** Human-readable startup output; retain the first line for readiness consumers. */
export interface NetworkAccessUrl {
  kind: "tailscale-https" | "tailscale" | "lan" | "virtual";
  url: string;
}

const KIND_LABEL: Record<NetworkAccessUrl["kind"], string> = {
  "tailscale-https": "Tailscale HTTPS",
  tailscale: "Tailscale",
  lan: "LAN",
  virtual: "Virtual",
};

export function formatWebStartup(options: {
  localUrl: string;
  networkUrls: readonly NetworkAccessUrl[];
  qrCode?: string;
  /** The server does not listen on a local address, so the first line carries no token. */
  localManagementUnavailable?: boolean;
}): string {
  const lines = [`codexhost web: ${options.localUrl}`];
  if (options.networkUrls.length > 0) {
    lines.push("", "Network access");
    for (const entry of options.networkUrls) {
      lines.push(`${`${KIND_LABEL[entry.kind]}:`.padEnd(15)}${entry.url}`);
    }
    lines.push(
      "These addresses need the access token: scan its QR code on this computer in Settings → Connect devices.",
      "HTTP on these addresses is not encrypted; use them only on networks you trust.",
    );
  }
  const preferred = options.networkUrls[0];
  if (preferred && options.qrCode !== undefined) {
    lines.push(
      "",
      `Phone access · ${KIND_LABEL[preferred.kind]}`,
      preferred.kind === "tailscale"
        ? "Connect both devices to Tailscale, then scan."
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
