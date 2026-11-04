/** Human-readable startup output; retain the first line for readiness consumers. */
export interface NetworkAccessUrl {
  kind: "tailscale" | "lan";
  url: string;
}

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
      const label = entry.kind === "tailscale" ? "Tailscale" : "LAN";
      lines.push(`${`${label}:`.padEnd(15)}${entry.url}`);
    }
    lines.push(
      "These addresses need an access token: create one on this computer in Settings → Access tokens.",
      "HTTP on these addresses is not encrypted; use them only on networks you trust.",
    );
  }
  const preferred = options.networkUrls[0];
  if (preferred && options.qrCode !== undefined) {
    lines.push(
      "",
      `Phone access · ${preferred.kind === "tailscale" ? "Tailscale" : "LAN"}`,
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
      "This address is not this computer's local address, so access tokens cannot be managed here.",
      "Listen on 127.0.0.1 or 0.0.0.0 to manage them.",
    );
  }
  lines.push("", "Keep access links private.", "");
  return lines.join("\n");
}
