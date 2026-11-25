import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { RelayOptions } from "./index.js";
import { defaultCertificateDirectory } from "./protocol.js";

interface Registration {
  id: string;
  name: string;
  tunnels: Set<() => void>;
}

/** Registration-scoped access to the current certificate authority, outside phone usage. */
export class CertificateRequests {
  directory: string;
  private target!: URL;
  private registrations = new Map<string, Registration>();

  constructor(
    directory = defaultCertificateDirectory,
    private externalAccount?: RelayOptions["externalAccount"],
  ) {
    this.directory = directory;
    this.setDirectory(directory);
  }

  setDirectory(directory: string): boolean {
    const target = new URL(directory);
    if (target.protocol !== "https:") throw new Error("Certificate directory must use https:");
    const changed = directory !== this.directory;
    this.directory = directory;
    this.target = target;
    return changed;
  }

  register(id: string, name: string): string {
    const token = randomBytes(32).toString("base64url");
    this.registrations.set(token, { id, name, tunnels: new Set() });
    return token;
  }

  unregister(token: string): void {
    const registration = this.registrations.get(token);
    this.registrations.delete(token);
    for (const close of registration?.tunnels ?? []) close();
  }

  private authenticate(authorization: string | undefined): Registration | undefined {
    return authorization?.startsWith("Bearer ")
      ? this.registrations.get(authorization.slice(7))
      : undefined;
  }

  async account(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const registration = this.authenticate(request.headers.authorization);
    if (!registration) {
      response.writeHead(401).end();
      return;
    }
    try {
      const result = await this.externalAccount?.({ id: registration.id, name: registration.name });
      if (this.authenticate(request.headers.authorization) !== registration) {
        response.writeHead(401).end();
      } else if (result === undefined) {
        response.writeHead(404).end();
      } else if ("keyId" in result) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } else if (result.retryAfter !== undefined) {
        response.writeHead(429, { "Retry-After": String(result.retryAfter) }).end();
      } else {
        response.writeHead(503).end();
      }
    } catch {
      response.writeHead(503).end();
    }
  }

  tunnel(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    const reject = (status: number, reason: string) => {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    const registration = this.authenticate(request.headers["proxy-authorization"]);
    if (!registration) return reject(407, "Proxy Authentication Required");
    const { hostname, port } = this.target;
    if (request.url?.toLowerCase() !== `${hostname}:${port || 443}`) {
      return reject(403, "Forbidden");
    }
    if (registration.tunnels.size >= 4) return reject(429, "Too Many Requests");

    const target = connect({ host: hostname.replace(/^\[|\]$/g, ""), port: Number(port || 443) });
    let connected = false;
    let idle: NodeJS.Timeout | undefined;
    const close = () => {
      clearTimeout(connectTimeout);
      clearTimeout(idle);
      registration.tunnels.delete(close);
      socket.destroy();
      target.destroy();
    };
    const failed = () => {
      clearTimeout(connectTimeout);
      registration.tunnels.delete(close);
      reject(502, "Bad Gateway");
      target.destroy();
    };
    const connectTimeout = setTimeout(failed, 10_000);
    connectTimeout.unref();
    registration.tunnels.add(close);
    socket.once("close", close);
    target.on("error", () => (connected ? close() : failed()));
    target.once("close", () => {
      if (connected) close();
    });
    target.once("connect", () => {
      connected = true;
      clearTimeout(connectTimeout);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      idle = setTimeout(close, 60_000);
      idle.unref();
      const activity = () => idle?.refresh();
      socket.on("data", activity);
      target.on("data", activity);
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
  }
}
