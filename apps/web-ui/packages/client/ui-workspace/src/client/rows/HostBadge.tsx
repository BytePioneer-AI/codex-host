import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import type { GroupNode } from "../tree.ts";
import css from "./Rows.module.css";

export function HostBadge({
  host,
  t,
}: {
  host?: GroupNode["remote"];
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
  return (
    <span
      className={css.hostBadge}
      data-host-id={host?.hostId ?? "local"}
      data-state={host?.state ?? "local"}
      role="img"
      aria-label={description}
      title={description}
    >
      <span>{label}</span>
      {host && <span className={css.hostDot} aria-hidden="true" />}
    </span>
  );
}
