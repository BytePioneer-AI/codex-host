import type { Server } from "node:http";
import type { RequestTrust } from "../request-trust.ts";
import { RelayTls } from "./tls.ts";
import type { WebAccessState, WebRelayState } from "@codexhost/shared-contracts";
import { readServiceOptions } from "../background-service.ts";
import type { DataDir } from "../store.ts";
import { relayIdentity } from "./identity.ts";
import { connectRelay } from "./client.ts";
import { Certificates } from "./certificates.ts";

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
    private readonly host: string | undefined,
    private readonly authenticated: boolean,
    server: Server,
    trust: RequestTrust,
  ) {
    this.tls = new RelayTls(server, trust);
    this.certificates = new Certificates(data, this.tls, () => this.updateCertificateState());
  }

  get configured(): boolean {
    return Boolean(this.host);
  }

  get access(): WebAccessState["relay"] {
    if (!this.configured) return;
    const { relayHostname } = readServiceOptions(this.data);
    return {
      state: this.state,
      identityPath: this.data.path("remote-relay", "identity.pem"),
      ...(relayHostname ? { hostname: relayHostname } : {}),
      ...(this.quotaUntil ? { quotaUntil: this.quotaUntil } : {}),
    };
  }

  start(): void {
    if (!this.configured || !this.authenticated) return;
    const saved = readServiceOptions(this.data);
    this.disconnect = connectRelay({
      host: this.host as string,
      identity: relayIdentity(this.data),
      name: saved.relayName ?? "",
      invite: saved.relayInvite ?? "",
      connecting: (reason) => {
        this.certificates.stop();
        this.hostname = undefined;
        this.state = { status: "connecting", ...(reason ? { reason } : {}) };
      },
      registered: (hostname) => {
        this.hostname = hostname;
        const saved = readServiceOptions(this.data);
        if (saved.relayHostname !== hostname) {
          this.data.writeJson(
            "service.json",
            { ...saved, relayHostname: hostname },
            { mode: 0o600 },
          );
        }
        this.certificates.start(hostname);
      },
      stopped: (reason) => {
        this.certificates.stop();
        this.hostname = undefined;
        if (reason === "invite" || reason === "name-taken" || reason === "banned") {
          this.setEnabled(false);
          if (reason === "invite" || reason === "name-taken") {
            const saved = readServiceOptions(this.data);
            delete saved.relayHostname;
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

  setEnabled(enabled: boolean, registration?: { name?: string; invite?: string }): void {
    this.data.writeJson(
      "service.json",
      {
        ...readServiceOptions(this.data),
        relayEnabled: enabled,
        ...(enabled && registration !== undefined
          ? { relayName: registration.name ?? "", relayInvite: registration.invite ?? "" }
          : {}),
      },
      { mode: 0o600 },
    );
    this.close();
    if (enabled) {
      this.certificates.enable();
      this.start();
    }
  }
}
