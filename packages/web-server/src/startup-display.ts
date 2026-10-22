/** Human-readable startup output; retain the first line for readiness consumers. */
export interface NetworkAccessUrl {
  kind: "tailscale" | "lan";
  url: string;
}

export function formatWebStartup(options: {
  localUrl: string;
  networkUrls: readonly NetworkAccessUrl[];
  qrCode?: string;
}): string {
  const lines = [`codexhost web: ${options.localUrl}`];
  if (options.networkUrls.length > 0) {
    lines.push("", "Network access");
    for (const entry of options.networkUrls) {
      const label = entry.kind === "tailscale" ? "Tailscale" : "LAN";
      lines.push(`${`${label}:`.padEnd(15)}${entry.url}`);
    }
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
  lines.push("", "Keep access links and QR codes private.", "");
  return lines.join("\n");
}
