/**
 * Sidebar browser forwarding for pages served on this machine's loopback.
 *
 * In a remote viewer's browser `localhost` names the viewer's machine, so each loopback origin is
 * exposed on its own Web-server listener and the viewer's browser renders it natively. A separate
 * port keeps the forwarded page cross-origin to the CodexHost application while the host-scoped
 * access cookie still authenticates it.
 */

import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { createProxyServer } from "http-proxy-3";
import {
  BROWSER_FORWARD_METHOD,
  isLoopbackBrowserHost,
  parseBrowserForwardParams,
} from "@codexhost/shared-contracts";

import { ACCESS_COOKIE } from "./auth.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";

/** Bounds the listeners one Web server opens; each loopback origin reuses its listener. */
const MAX_FORWARDS = 32;

export interface BrowserForwardingOptions {
  /** Listener address; the Web server's own, so forwarded pages are reachable wherever it is. */
  readonly host: string;
  /** The Web server's port, which is never forwarded. */
  readonly serverPort: () => number;
  /** The Web server's access check; undefined when authentication is disabled. */
  readonly authorized: ((request: IncomingMessage) => boolean) | undefined;
}

interface Forward {
  readonly server: Server;
  readonly port: number;
}

export class BrowserForwarding {
  private readonly forwards = new Map<string, Promise<Forward>>();
  private readonly ports = new Set<number>();
  private closed = false;

  constructor(private readonly options: BrowserForwardingOptions) {}

  register(rpc: RpcRegistry): void {
    rpc.register(BROWSER_FORWARD_METHOD, async (args) => {
      const params = parseBrowserForwardParams(args);
      if (params === undefined) throw invalid("Forwarding needs a URL.");
      return { port: await this.forward(params.url) };
    });
  }

  /**
   * @param value - HTTP(S) URL on this machine's loopback.
   * @returns the listener port serving that URL's origin.
   */
  async forward(value: string): Promise<number> {
    if (this.closed) throw new RpcError("browser-forward/closed", "The Web server is stopping.");
    const target = this.target(value);
    let pending = this.forwards.get(target.origin);
    if (pending === undefined) {
      if (this.forwards.size >= MAX_FORWARDS)
        throw new RpcError(
          "browser-forward/limit",
          `At most ${String(MAX_FORWARDS)} local addresses can be forwarded; restart the Web server to release them.`,
        );
      pending = this.listen(target);
      this.forwards.set(target.origin, pending);
      pending.catch(() => this.forwards.delete(target.origin));
    }
    return (await pending).port;
  }

  async close(): Promise<void> {
    this.closed = true;
    const forwards = await Promise.allSettled(this.forwards.values());
    this.forwards.clear();
    for (const forward of forwards) {
      if (forward.status !== "fulfilled") continue;
      forward.value.server.close();
      forward.value.server.closeAllConnections();
    }
  }

  private target(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid("The address is not a valid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw invalid("Only HTTP and HTTPS addresses can be forwarded.");
    if (url.username !== "" || url.password !== "")
      throw invalid("Addresses cannot contain a username or password.");
    if (!isLoopbackBrowserHost(url.hostname))
      throw invalid("Only addresses on the Web server's loopback are forwarded.");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (port === this.options.serverPort() || this.ports.has(port))
      throw invalid(`Port ${String(port)} is the CodexHost Web service; open it directly.`);
    return url;
  }

  private listen(target: URL): Promise<Forward> {
    // Names under .localhost do not resolve everywhere; connect to localhost and keep the name in Host.
    const connect = new URL(target.origin);
    if (connect.hostname.endsWith(".localhost")) connect.hostname = "localhost";
    const proxy = createProxyServer({ target: connect, ws: true, secure: false });
    const rewriteRequest = (
      outgoing: {
        setHeader(name: string, value: string): unknown;
        removeHeader(name: string): unknown;
      },
      request: IncomingMessage,
    ) => {
      const own = ownOrigin(request);
      outgoing.setHeader("host", target.host);
      const origin = request.headers.origin;
      if (origin === own) outgoing.setHeader("origin", target.origin);
      const referer = request.headers.referer;
      if (referer?.startsWith(`${own}/`))
        outgoing.setHeader("referer", target.origin + referer.slice(own.length));
      const cookie = withoutAccessCookie(request.headers.cookie);
      if (cookie === undefined) outgoing.removeHeader("cookie");
      else outgoing.setHeader("cookie", cookie);
    };
    proxy.on("proxyReq", (outgoing, request) => {
      rewriteRequest(outgoing, request);
    });
    proxy.on("proxyReqWs", (outgoing, request) => {
      rewriteRequest(outgoing, request);
    });
    proxy.on("proxyRes", (response, request) => {
      rewriteResponseHeaders(response.headers, target.origin, ownOrigin(request));
    });
    proxy.on("error", (_error, _request, response) => {
      if (!("writeHead" in response)) {
        (response as Socket).destroy();
        return;
      }
      if (!response.headersSent)
        response
          .writeHead(502, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          })
          .end(
            `Nothing answered at ${target.origin} on the CodexHost machine. Start the service, then reload.`,
          );
      else response.destroy();
    });

    const server = createServer((request, response) => {
      if (!this.allowed(request)) {
        response
          .writeHead(401, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          })
          .end("Sign in to CodexHost in this browser, then reload.");
        return;
      }
      proxy.web(request, response);
    });
    server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
      if (!this.allowed(request)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      proxy.ws(request, socket, head);
    });
    server.on("close", () => {
      proxy.close();
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.options.host, () => {
        server.off("error", reject);
        const { port } = server.address() as AddressInfo;
        this.ports.add(port);
        if (this.closed) {
          server.close();
          reject(new RpcError("browser-forward/closed", "The Web server is stopping."));
          return;
        }
        resolve({ server, port });
      });
    });
  }

  private allowed(request: IncomingMessage): boolean {
    return this.options.authorized === undefined || this.options.authorized(request);
  }
}

function invalid(message: string): RpcError {
  return new RpcError("browser-forward/invalid", message);
}

/** The listener origin as the viewer addressed it; listeners serve plain HTTP. */
function ownOrigin(request: IncomingMessage): string {
  return `http://${request.headers.host ?? ""}`;
}

/** The forwarded service never receives the CodexHost access token. */
export function withoutAccessCookie(cookie: string | undefined): string | undefined {
  const kept = (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part.split("=")[0]?.trim() !== ACCESS_COOKIE);
  return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * Adapt a loopback service's response to its forwarded origin: redirects to the service return to
 * the listener, cookies are stored for the listener host over HTTP, and the CodexHost sidebar may
 * frame the page. Cross-site framers stay unauthenticated because the access cookie is SameSite=Lax.
 */
export function rewriteResponseHeaders(
  headers: OutgoingHttpHeaders,
  targetOrigin: string,
  ownOrigin: string,
): void {
  const location = headers.location;
  if (typeof location === "string") {
    try {
      const url = new URL(location);
      if (url.origin === targetOrigin)
        headers.location = ownOrigin + url.href.slice(url.origin.length);
    } catch {
      // Relative redirects already resolve against the listener.
    }
  }
  const cookies = headers["set-cookie"];
  if (Array.isArray(cookies)) {
    headers["set-cookie"] = cookies.flatMap((cookie) => {
      const forwarded = forwardedSetCookie(cookie);
      return forwarded === undefined ? [] : [forwarded];
    });
  }
  delete headers["x-frame-options"];
  const policy = headers["content-security-policy"];
  if (typeof policy === "string") {
    const kept = withoutFrameAncestors(policy);
    if (kept === undefined) delete headers["content-security-policy"];
    else headers["content-security-policy"] = kept;
  }
}

function forwardedSetCookie(cookie: string): string | undefined {
  const [pair = "", ...attributes] = cookie.split(";");
  if (pair.split("=")[0]?.trim() === ACCESS_COOKIE) return undefined;
  const kept = attributes
    .map((attribute) => attribute.trim())
    .filter((attribute) => {
      const name = attribute.split("=")[0]?.trim().toLowerCase();
      return name !== "domain" && name !== "secure";
    })
    .map((attribute) => (/^samesite\s*=\s*none$/iu.test(attribute) ? "SameSite=Lax" : attribute));
  return [pair.trim(), ...kept].join("; ");
}

function withoutFrameAncestors(policy: string): string | undefined {
  const kept = policy
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "" && !/^frame-ancestors(\s|$)/iu.test(directive));
  return kept.length === 0 ? undefined : kept.join("; ");
}
