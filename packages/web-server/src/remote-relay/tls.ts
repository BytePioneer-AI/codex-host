import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { constants, type IncomingHttpHeaders, type ServerHttp2Stream } from "node:http2";
import { createSecureContext, TLSSocket, type SecureContext } from "node:tls";
import { headers } from "@codexhost/remote-relay/protocol";
import type { RequestTrust } from "../request-trust.ts";
import type { DataDir } from "../store.ts";

/** Terminates phone TLS on relay streams without opening a listener. */
export class RelayTls {
  private context: SecureContext | undefined;

  constructor(
    private readonly data: DataDir,
    private readonly server: Server,
    private readonly trust: RequestTrust,
  ) {}

  get available(): boolean {
    return this.context !== undefined;
  }

  reload(): boolean {
    try {
      this.context = createSecureContext({
        cert: readFileSync(this.data.path("remote-relay", "certificate.pem")),
        key: readFileSync(this.data.path("remote-relay", "certificate-key.pem")),
      });
    } catch {
      this.context = undefined;
    }
    return this.available;
  }

  accept(stream: ServerHttp2Stream, request: IncomingHttpHeaders, hostname: string): void {
    if (this.context === undefined) {
      stream.close(constants.NGHTTP2_CANCEL);
      return;
    }
    const socket = new TLSSocket(stream, {
      isServer: true,
      secureContext: this.context,
      ALPNProtocols: ["http/1.1"],
    });
    // A bare TLSSocket has no handshake deadline; tls.Server would apply one.
    const handshake = setTimeout(() => socket.destroy(), 10_000);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => clearTimeout(handshake));
    socket.once("secure", () => {
      clearTimeout(handshake);
      this.trust.relaySockets.set(socket, {
        address: request[headers.clientAddress] as string,
        origin: `https://${hostname}`,
      });
      this.server.emit("connection", socket);
    });
  }
}
