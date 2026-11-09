import type { Server } from "node:http";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RequestTrust } from "../request-trust.ts";
import { RelayTls } from "./tls.ts";
import type { WebAccessState, WebRelayKind, WebRelayState } from "@codexhost/shared-contracts";
import { readServiceOptions } from "../background-service.ts";
import type { DataDir } from "../store.ts";
import { relayIdentity } from "./identity.ts";
import { connectRelay } from "./client.ts";
import { Certificates } from "./certificates.ts";
import { OFFICIAL_RELAY_HOST, relayHost, relayKind } from "./settings.ts";
import { RpcError } from "../transport.ts";

/** Owns the saved switch and the lifetime of this Web process's relay connection. */
export class RemoteRelay {
  state: WebRelayState = { status: "off" };
  private disconnect: (() => void) | undefined;
  private readonly tls: RelayTls;
  private readonly certificates: Certificates;
  private hostname: string | undefined;
  private quotaUntil: string | undefined;
  private quotaTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly data: DataDir,
    private readonly authenticated: boolean,
    server: Server,
    trust: RequestTrust,
    private readonly connect = connectRelay,
  ) {
    // Legacy files belong to the legacy assignment, which migrated to its own endpoint; after
    // a control address change they have no owner and must not reach another endpoint.
    const saved = readServiceOptions(data);
    const host = relayHost(saved);
    const owner = host && saved.relayRegistrations[host]?.hostname ? host : undefined;
    const directory = owner && data.path("remote-relay", "endpoints", encodeURIComponent(owner));
    for (const file of ["certificate.pem", "certificate-state.json"]) {
      const legacy = data.path("remote-relay", file);
      if (!existsSync(legacy)) continue;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        renameSync(legacy, join(directory, file));
      } else rmSync(legacy, { force: true });
    }
    this.tls = new RelayTls(server, trust);
    this.certificates = new Certificates(data, this.tls, () => this.updateCertificateState());
  }

  get access(): NonNullable<WebAccessState["relay"]> {
    const saved = readServiceOptions(this.data);
    const officialHostname = saved.relayRegistrations[OFFICIAL_RELAY_HOST]?.hostname;
    const customHostname = saved.relayHost
      ? saved.relayRegistrations[saved.relayHost]?.hostname
      : undefined;
    return {
      state: this.state,
      enabled: saved.relayEnabled && this.authenticated,
      kind: relayKind(saved),
      officialHost: OFFICIAL_RELAY_HOST,
      ...(saved.relayHost ? { customHost: saved.relayHost } : {}),
      ...(officialHostname ? { officialHostname } : {}),
      ...(customHostname ? { customHostname } : {}),
      ...(this.quotaUntil ? { quotaUntil: this.quotaUntil } : {}),
    };
  }

  start(): void {
    if (!this.authenticated) return;
    const saved = readServiceOptions(this.data);
    const host = relayHost(saved);
    if (!host) return;
    const official = relayKind(saved) === "official";
    const registration = saved.relayRegistrations[host];
    this.disconnect = this.connect({
      host,
      identity: relayIdentity(this.data),
      name: registration?.name ?? "",
      invite: official ? (registration?.invite ?? "") : "",
      connecting: (reason) => {
        this.certificates.stop();
        this.hostname = undefined;
        this.state = { status: "connecting", ...(reason ? { reason } : {}) };
      },
      registered: (hostname) => {
        this.hostname = hostname;
        const saved = readServiceOptions(this.data);
        if (saved.relayRegistrations[host]?.hostname !== hostname) {
          saved.relayRegistrations[host] = { ...saved.relayRegistrations[host], hostname };
          this.data.writeJson("service.json", saved, { mode: 0o600 });
        }
        this.certificates.start(hostname, host);
      },
      stopped: (reason) => {
        this.certificates.stop();
        this.hostname = undefined;
        if (reason === "invite" || reason === "name-taken" || reason === "banned") {
          this.setEnabled(false);
          if (reason === "invite" || reason === "name-taken") {
            const saved = readServiceOptions(this.data);
            const registration = saved.relayRegistrations[host];
            if (registration) delete registration.hostname;
            this.data.writeJson("service.json", saved, { mode: 0o600 });
          }
          this.state = { status: "off", reason };
        } else {
          this.state = { status: "stopped", reason };
        }
      },
      notice: (until) => {
        clearTimeout(this.quotaTimer);
        this.quotaUntil = until;
        this.quotaTimer = setTimeout(
          () => {
            this.quotaUntil = undefined;
          },
          Date.parse(until) - Date.now(),
        );
        this.quotaTimer.unref();
      },
      tcp: (stream, request) => this.tls.accept(stream, request, this.hostname as string),
    });
  }

  close(): void {
    clearTimeout(this.quotaTimer);
    this.quotaUntil = undefined;
    this.certificates.stop();
    this.disconnect?.();
    this.disconnect = undefined;
    this.hostname = undefined;
    this.state = { status: "off" };
  }

  private updateCertificateState(): void {
    if (this.hostname === undefined) return;
    this.state = {
      status: this.tls.available ? "connected" : "missing-certificate",
      url: `https://${this.hostname}/`,
      certificate: this.certificates.state,
    };
  }

  setEnabled(
    enabled: boolean,
    registration?: { name?: string; invite?: string },
    configuration: { kind?: WebRelayKind | undefined; host?: string | undefined } = {},
  ): void {
    const saved = readServiceOptions(this.data);
    const next = {
      ...saved,
      relayEnabled: enabled,
      relayKind: configuration.kind ?? relayKind(saved),
      ...(configuration.host === undefined ? {} : { relayHost: configuration.host }),
    };
    if (
      saved.relayEnabled &&
      (relayKind(saved) !== relayKind(next) || saved.relayHost !== next.relayHost)
    )
      throw new RpcError(
        "relay/enabled",
        "Turn off the active relay before switching or changing its address",
        {},
      );
    if (enabled && !relayHost(next))
      throw new RpcError("relay/not-configured", "Enter a self-hosted relay hostname first", {});
    if (enabled && registration !== undefined) {
      const host = relayHost(next) as string;
      next.relayRegistrations[host] = {
        ...next.relayRegistrations[host],
        name: registration.name ?? "",
        ...(next.relayKind === "official" ? { invite: registration.invite ?? "" } : {}),
      };
    }
    this.data.writeJson("service.json", next, { mode: 0o600 });
    this.close();
    if (enabled) {
      this.certificates.enable();
      this.start();
    }
  }
}
