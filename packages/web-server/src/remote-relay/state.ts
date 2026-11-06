import type { Server } from "node:http";
import type { RequestTrust } from "../request-trust.ts";
import { RelayTls } from "./tls.ts";
import type { WebAccessState, WebRelayState } from "@codexhost/shared-contracts";
import { readServiceOptions } from "../background-service.ts";
import type { DataDir } from "../store.ts";
import { relayIdentity } from "./identity.ts";
import { connectRelay } from "./client.ts";

/** Owns the saved switch and the lifetime of this Web process's relay connection. */
export class RemoteRelay {
  state: WebRelayState = { status: "off" };
  private disconnect: (() => void) | undefined;
  private readonly tls: RelayTls;
  private hostname: string | undefined;

  constructor(
    private readonly data: DataDir,
    private readonly host: string | undefined,
    private readonly authenticated: boolean,
    server: Server,
    trust: RequestTrust,
  ) {
    this.tls = new RelayTls(data, server, trust);
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
    this.tls.reload();
    this.disconnect = connectRelay({
      host: this.host as string,
      identity: relayIdentity(this.data),
      connecting: () => {
        this.hostname = undefined;
        this.state = { status: "connecting" };
      },
      registered: (hostname) => {
        this.hostname = hostname;
        this.updateCertificateState();
      },
      stopped: (reason) => {
        this.hostname = undefined;
        this.state = { status: "stopped", reason };
      },
      tcp: (stream, request) => this.tls.accept(stream, request, this.hostname as string),
    });
  }

  close(): void {
    this.disconnect?.();
    this.disconnect = undefined;
    this.hostname = undefined;
    this.state = { status: "off" };
  }

  reloadCertificate(): void {
    this.tls.reload();
    if (this.hostname !== undefined) this.updateCertificateState();
  }

  private updateCertificateState(): void {
    this.state = {
      status: this.tls.available ? "connected" : "missing-certificate",
      url: `https://${this.hostname}/`,
    };
  }

  setEnabled(enabled: boolean): void {
    this.data.writeJson("service.json", {
      ...readServiceOptions(this.data),
      relayEnabled: enabled,
    });
    this.close();
    if (enabled) this.start();
  }
}
