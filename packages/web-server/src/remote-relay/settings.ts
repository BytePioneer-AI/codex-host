import { rmSync } from "node:fs";
import type { DataDir } from "../store.ts";

export const OFFICIAL_RELAY_HOST = "relay.chost.dev";

export interface RelaySettings {
  relayHost?: string | undefined;
  relayKind?: "official" | "self-hosted" | undefined;
}

/** Infer legacy files from the control address without changing their saved assignment. */
export function relayKind(settings: RelaySettings): "official" | "self-hosted" {
  return (
    settings.relayKind ??
    (settings.relayHost && settings.relayHost !== OFFICIAL_RELAY_HOST ? "self-hosted" : "official")
  );
}

export function relayHost(settings: RelaySettings): string | undefined {
  return relayKind(settings) === "official" ? OFFICIAL_RELAY_HOST : settings.relayHost;
}

/** An assignment and its certificate belong to one control endpoint, not just a DNS suffix. */
export function clearRelayAssignment(data: DataDir, settings: Record<string, unknown>): void {
  for (const field of ["relayHostname", "relayName", "relayInvite"])
    Reflect.deleteProperty(settings, field);
  for (const file of ["certificate.pem", "certificate-state.json"])
    rmSync(data.path("remote-relay", file), { force: true });
}
