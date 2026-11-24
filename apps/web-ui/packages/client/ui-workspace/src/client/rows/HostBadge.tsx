import clsx from "clsx";
import { resolveRemotePeerColor } from "@codexhost/shared-contracts";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import type { GroupNode } from "../tree.ts";
import css from "./Rows.module.css";

export function HostBadge({
  host,
  variant = "workspace",
  t,
}: {
  host?: GroupNode["remote"];
  variant?: "workspace" | "session";
  t: WorkspaceBrowserProps["t"];
}) {
  const label = host?.displayName ?? t("host.local");
  const status =
    host?.state === "connected"
      ? t("host.connected")
      : host?.state === "connecting"
        ? t("host.connecting")
        : t("host.disconnected");
  const description = host ? `${label} · ${status}` : label;
  const color = host !== undefined ? resolveRemotePeerColor(host.hostId, host.color) : undefined;
  return (
    <span
      className={clsx(css.hostBadge, variant === "session" && css.hostBadgeSession)}
      data-host-id={host?.hostId ?? "local"}
      data-state={host?.state ?? "local"}
      data-color={color}
      role="img"
      aria-label={description}
      title={description}
    >
      {host !== undefined && <span className={css.hostDot} aria-hidden="true" />}
      <span className={css.hostLabel}>{label}</span>
    </span>
  );
}
