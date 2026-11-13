import { once } from "node:events";
import { request, type ClientRequest, type RequestOptions } from "node:http";
import { Agent, type RequestOptions as HttpsRequestOptions } from "node:https";
import { addAbortSignal, type Duplex } from "node:stream";
import { connect, type ConnectionOptions } from "node:tls";
import { paths } from "@codexhost/remote-relay/protocol";

export interface CertificateRelay {
  host: string;
  token: string;
}

function tunnel(options: RequestOptions): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const req = request(options);
    req.on("error", reject);
    req.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Certificate tunnel returned HTTP ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.end();
  });
}

/** One issuance round's authenticated transport, including its account credential request. */
export class CertificateTransport extends Agent {
  constructor(
    private readonly relay: CertificateRelay,
    private readonly signal: AbortSignal,
  ) {
    super({ keepAlive: true, autoSelectFamilyAttemptTimeout: 2_000 });
  }

  private controlRequest(options: RequestOptions): ClientRequest {
    const control = new URL(`https://${this.relay.host}`);
    return request({
      ...options,
      hostname: control.hostname,
      port: control.port || 443,
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
      createConnection: (_options, callback) => {
        void this.controlConnection().then(
          (socket) => callback(null, socket),
          // Node's callback type requires a socket even when creation fails.
          (error: Error) => callback(error, undefined as unknown as Duplex),
        );
        return undefined;
      },
    });
  }

  private async controlConnection(): Promise<Duplex> {
    const control = new URL(`https://${this.relay.host}`);
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]);
    const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy;
    const proxy = proxyValue?.startsWith("http://") ? new URL(proxyValue) : undefined;
    const authority = `${control.hostname}:${control.port || 443}`;
    const socket = proxy
      ? await tunnel({
          hostname: proxy.hostname,
          port: proxy.port || 80,
          method: "CONNECT",
          path: authority,
          headers: { host: authority },
          signal,
        })
      : undefined;
    const options = {
      ...(socket ? { socket } : { host: control.hostname, port: Number(control.port || 443) }),
      servername: control.hostname,
      ALPNProtocols: ["http/1.1"],
      autoSelectFamilyAttemptTimeout: 2_000,
    };
    return this.secureConnection(options);
  }

  private async secureConnection(options: ConnectionOptions): Promise<Duplex> {
    const tls = addAbortSignal(this.signal, connect(options));
    const deadline = setTimeout(
      () => tls.destroy(new Error("Certificate TLS connection timed out")),
      30_000,
    );
    try {
      await once(tls, "secureConnect");
      return tls;
    } finally {
      clearTimeout(deadline);
    }
  }

  override createConnection(
    options: HttpsRequestOptions,
    callback?: (error: Error | null, socket: Duplex) => void,
  ): undefined {
    const req = this.controlRequest({
      method: "CONNECT",
      path: `${options.host}:${options.port || 443}`,
      headers: {
        host: `${options.host}:${options.port || 443}`,
        "proxy-authorization": `Bearer ${this.relay.token}`,
      },
    });
    req.on("error", (error) => callback?.(error, undefined as unknown as Duplex));
    req.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback?.(
          new Error(`Certificate tunnel returned HTTP ${response.statusCode}`),
          undefined as unknown as Duplex,
        );
        return;
      }
      if (head.length) socket.unshift(head);
      void this.secureConnection({
        socket,
        servername: options.servername || String(options.host),
      }).then(
        (tls) => callback?.(null, tls),
        (error: Error) => callback?.(error, undefined as unknown as Duplex),
      );
    });
    req.end();
    return undefined;
  }

  externalAccount(): Promise<{ status: number; body: string; retryAfter: string | undefined }> {
    return new Promise((resolve, reject) => {
      const req = this.controlRequest({
        method: "POST",
        path: paths.externalAccount,
        headers: { authorization: `Bearer ${this.relay.token}` },
      });
      req.on("error", reject);
      req.once("response", async (response) => {
        try {
          let body = "";
          for await (const chunk of response) body += chunk;
          resolve({
            status: response.statusCode as number,
            body,
            retryAfter: response.headers["retry-after"],
          });
        } catch (error) {
          reject(error);
        }
      });
      req.end();
    });
  }
}
