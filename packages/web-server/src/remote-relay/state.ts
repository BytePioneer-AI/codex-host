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
    return this.configured
      ? { state: this.state, identityPath: this.data.path("remote-relay", "identity.pem") }
      : undefined;
  }

  start(): void {
    if (!this.configured || !this.authenticated) return;
    this.disconnect = connectRelay({
      host: this.host as string,
      identity: relayIdentity(this.data),
      connecting: () => {
        this.certificates.stop();
        this.hostname = undefined;
        this.state = { status: "connecting" };
      },
      registered: (hostname) => {
        this.hostname = hostname;
        this.certificates.start(hostname);
      },
      stopped: (reason) => {
        this.certificates.stop();
        this.hostname = undefined;
        this.state = { status: "stopped", reason };
      },
      tcp: (stream, request) => this.tls.accept(stream, request, this.hostname as string),
    });
  }

  close(): void {
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

  setEnabled(enabled: boolean): void {
    this.data.writeJson("service.json", {
      ...readServiceOptions(this.data),
      relayEnabled: enabled,
    });
    this.close();
    if (enabled) {
      this.certificates.enable();
      this.start();
    }
  }
}
