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
