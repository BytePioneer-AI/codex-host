import type { Server } from "node:http";
import {
  createServer as createHttp2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import { createSecureContext, createServer as createTlsServer, type SecureContext } from "node:tls";
import { readClientHello } from "@codexhost/remote-relay/client-hello";
import { headers, paths } from "@codexhost/remote-relay/protocol";
import type { RequestTrust } from "../request-trust.ts";
import { HTTP_KEEP_ALIVE_TIMEOUT } from "../http-server.ts";

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
        // A TLS server completes Node's server-side handshake lifecycle before
        // HTTP/2 takes ownership. It has no listener; the relay stream is its input.
        const tls = createTlsServer({
          SNICallback: (_servername, callback) => callback(null, context),
          ALPNProtocols: challenge ? ["acme-tls/1"] : ["h2", "http/1.1"],
        });
        tls.once("secureConnection", (socket) => {
          // Do not inherit the tunnel's half-open mode and retain slots after browser EOF.
          socket.allowHalfOpen = false;
          socket.on("error", () => socket.destroy());
          clearTimeout(deadline);
          if (challenge) {
            socket.end(() => socket.destroy());
            return;
          }
          const id = request[headers.connectionId];
          let reportedDay: string | undefined;
          const peer = {
            address: request[headers.clientAddress] as string,
            origin: `https://${hostname}`,
            authenticated: () => {
              const day = new Date().toISOString().slice(0, 10);
              if (typeof id !== "string" || reportedDay === day || stream.destroyed) return;
              try {
                stream.pushStream(
                  {
                    ":method": "GET",
                    ":path": paths.authenticated,
                    [headers.connectionId]: id,
                  },
                  (error, report) => {
                    if (error) {
                      if (reportedDay === day) reportedDay = undefined;
                      return;
                    }
                    report.on("error", () => {
                      if (reportedDay === day) reportedDay = undefined;
                      report.destroy();
                    });
                    try {
                      report.respond({ ":status": 204 });
                      report.end();
                    } catch {
                      if (reportedDay === day) reportedDay = undefined;
                      report.destroy();
                    }
                  },
                );
                reportedDay = day;
              } catch {
                // Telemetry must not affect login or access, including on older relay servers.
              }
            },
          };
          this.trust.relaySockets.set(socket, peer);
          if (socket.alpnProtocol === "h2") {
            const http2 = createHttp2Server((request, response) => {
              // Compatibility requests expose a per-stream socket proxy. Bind
              // this connection's relay identity before auth and shared routing.
              this.trust.relaySockets.set(request.socket, peer);
              this.server.emit("request", request, response);
            });
            http2.on("session", (session) => {
              session.setTimeout(HTTP_KEEP_ALIVE_TIMEOUT, () => session.close());
            });
            http2.emit("connection", socket);
          } else {
            // Includes WebSocket Upgrade; extended CONNECT is not advertised.
            this.server.emit("connection", socket);
          }
        });
        tls.emit("connection", stream);
      })
      .catch(() => stream.destroy());
  }
}
