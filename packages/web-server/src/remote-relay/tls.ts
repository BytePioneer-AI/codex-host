import type { Server } from "node:http";
import type { IncomingHttpHeaders, ServerHttp2Stream } from "node:http2";
import { createSecureContext, TLSSocket, type SecureContext } from "node:tls";
import { readClientHello } from "@codexhost/remote-relay/client-hello";
import { headers } from "@codexhost/remote-relay/protocol";
import type { RequestTrust } from "../request-trust.ts";

/** Terminates phone and ACME TLS on relay streams without opening a listener. */
export class RelayTls {
  private context: SecureContext | undefined;
  private challenge: { hostname: string; context: SecureContext } | undefined;

  constructor(
    private readonly server: Server,
    private readonly trust: RequestTrust,
  ) {}

  get available(): boolean {
    return this.context !== undefined;
  }

  useCertificate(context: SecureContext): void {
    this.context = context;
  }

  clear(): void {
    this.context = undefined;
  }

  setChallenge(hostname: string, cert: Buffer, key: Buffer): void {
    this.challenge = {
      hostname: hostname.toLowerCase(),
      context: createSecureContext({ cert, key, minVersion: "TLSv1.2" }),
    };
  }

  clearChallenge(): void {
    this.challenge = undefined;
  }

  accept(stream: ServerHttp2Stream, request: IncomingHttpHeaders, hostname: string): void {
    const deadline = setTimeout(() => stream.destroy(), 10_000);
    stream.once("close", () => clearTimeout(deadline));
    void readClientHello(stream)
      .then(({ servername, alpn }) => {
        const challenge = alpn.length === 1 && alpn[0] === "acme-tls/1";
        const context = challenge
          ? this.challenge?.hostname === servername.toLowerCase()
            ? this.challenge.context
            : undefined
          : this.context;
        if (context === undefined) {
          stream.destroy();
          return;
        }
        const socket = new TLSSocket(stream, {
          isServer: true,
          secureContext: context,
          ALPNProtocols: [challenge ? "acme-tls/1" : "http/1.1"],
        });
        socket.on("error", () => socket.destroy());
        socket.once("close", () => clearTimeout(deadline));
        socket.once("secure", () => {
          clearTimeout(deadline);
          if (challenge) {
            socket.end(() => socket.destroy());
            return;
          }
          this.trust.relaySockets.set(socket, {
            address: request[headers.clientAddress] as string,
            origin: `https://${hostname}`,
          });
          this.server.emit("connection", socket);
        });
      })
      .catch(() => stream.destroy());
  }
}
