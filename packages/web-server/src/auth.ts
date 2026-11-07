/**
 * Access-token authentication for the Web server.
 *
 * A request presents a token as an HttpOnly cookie or as `Authorization: Bearer <token>` (native
 * clients). Browsers obtain the cookie from `POST /api/auth/login`, used by the sign-in page and by
 * `#token=` links, or from `?token=`, which accepts only the local token so that the access token
 * stays out of proxy logs. `POST /api/auth/logout` removes the cookie from this browser only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { AccessTokenStore } from "./access-tokens.ts";
import { signInDocument, type SignInNotice } from "./auth-page.ts";
import { isLocalConnection, type RequestTrust } from "./request-trust.ts";

const cookieName = (secure: boolean): string =>
  secure ? "__Host-codexhost_token" : "codexhost_token";
const COOKIE_MAX_AGE_SECONDS = 31_536_000;
const LOGIN_BODY_LIMIT_BYTES = 4096;
const FAILURE_LIMIT = 10;
const FAILURE_WINDOW_MS = 60_000;
/** Static shell assets carry no data, so they load without a token and never count as failures. */
const PUBLIC_ASSET =
  /^\/(assets\/.*|favicon[^/]*\.svg|manifest\.webmanifest|apple-touch-icon\.png|icon-\d+\.png|sw\.js)$/u;

/** Credential id of the local token; the access token uses its own id. */
export const LOCAL_CREDENTIAL = "local";

/** What one authenticated request established. */
export interface RequestAuth {
  /** Owner of this request's connections and push subscriptions. */
  readonly credential: string;
  readonly local: boolean;
  /** Keep this response alive through a revocation it caused, so it can report the result. */
  release(): void;
}

/** Live connections per credential, destroyed when that credential is revoked. */
export class CredentialConnections {
  private readonly open = new Map<string, Set<{ destroy(): unknown }>>();

  /** @returns a function that stops tracking the connection. */
  track(
    credential: string,
    connection: { destroy(): unknown; once(event: "close", listener: () => void): unknown },
  ): () => void {
    let connections = this.open.get(credential);
    if (connections === undefined) {
      connections = new Set();
      this.open.set(credential, connections);
    }
    const tracked = connections;
    tracked.add(connection);
    const release = (): void => {
      tracked.delete(connection);
      if (tracked.size === 0 && this.open.get(credential) === tracked) this.open.delete(credential);
    };
    connection.once("close", release);
    return release;
  }

  revoke(credential: string): void {
    const connections = this.open.get(credential);
    this.open.delete(credential);
    for (const connection of connections ?? []) connection.destroy();
  }
}

/** Failed-token counting per client address: fixed window, then a block of the same length. */
export class FailedSignInLimit {
  private readonly entries = new Map<
    string,
    { windowStart: number; failures: number; blockedUntil: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  blocked(address: string): boolean {
    return (this.entries.get(address)?.blockedUntil ?? 0) > this.now();
  }

  fail(address: string): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.windowStart >= FAILURE_WINDOW_MS)
        this.entries.delete(key);
    }
    const entry = this.entries.get(address) ?? { windowStart: now, failures: 0, blockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= FAILURE_LIMIT) entry.blockedUntil = now + FAILURE_WINDOW_MS;
    this.entries.set(address, entry);
  }
}

function presentedToken(
  request: IncomingMessage,
  secure: boolean,
): { token: string; source: "bearer" | "cookie" } | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer "))
    return { token: header.slice("Bearer ".length).trim(), source: "bearer" };
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== cookieName(secure)) continue;
    try {
      return { token: decodeURIComponent(rest.join("=")), source: "cookie" };
    } catch {
      return { token: "", source: "cookie" };
    }
  }
  return undefined;
}

export class AccessAuth {
  private readonly limit = new FailedSignInLimit();

  constructor(
    private readonly tokens: AccessTokenStore,
    private readonly trust: RequestTrust,
    private readonly connections: CredentialConnections,
  ) {}

  /** @returns the credential this token grants on this connection, if any. */
  private credentialFor(token: string, request: IncomingMessage): string | undefined {
    if (this.tokens.isLocalToken(token))
      return isLocalConnection(request) ? LOCAL_CREDENTIAL : undefined;
    return this.tokens.resolve(token);
  }

  private cookie(request: IncomingMessage, value: string, maxAge: number): string {
    const secure = this.trust.secure(request) ? "; Secure" : "";
    return `${cookieName(this.trust.secure(request))}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}${secure}`;
  }

  private signInPage(
    request: IncomingMessage,
    response: ServerResponse,
    status: 401 | 429,
    notice?: SignInNotice,
  ): void {
    response
      .writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(signInDocument(request, notice));
  }

  /**
   * Admit one HTTP request or answer it.
   * @returns `handled` when the response was written; otherwise the request's authentication, which
   * is undefined only for a public asset requested without a valid token.
   */
  async gate(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<{ handled: true } | { handled: false; auth: RequestAuth | undefined }> {
    if (pathname === "/api/auth/login" && request.method === "POST") {
      await this.serveLogin(request, response);
      return { handled: true };
    }
    if (pathname === "/api/auth/logout" && request.method === "POST") {
      this.serveLogout(request, response);
      return { handled: true };
    }
    if ((pathname === "/" || pathname === "/index.html") && this.exchange(request, response))
      return { handled: true };
    const presented = presentedToken(request, this.trust.secure(request));
    const credential =
      presented === undefined ? undefined : this.credentialFor(presented.token, request);
    if (credential !== undefined) {
      const auth = this.admit(request, response, credential);
      if (pathname !== "/api/auth/status") return { handled: false, auth };
      response
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ authenticated: true, local: auth.local }));
      return { handled: true };
    }
    if (PUBLIC_ASSET.test(pathname)) return { handled: false, auth: undefined };
    const status = presented === undefined ? 401 : this.countFailure(request);
    if (presented?.source === "cookie")
      response.setHeader("set-cookie", this.cookie(request, "", 0));
    if (pathname.startsWith("/api/") || pathname.startsWith("/plugins/")) {
      response
        .writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" })
        .end(status === 429 ? "too many attempts" : "authentication required");
    } else {
      const notice = status === 429 ? "limited" : presented === undefined ? undefined : "expired";
      this.signInPage(request, response, status, notice);
    }
    return { handled: true };
  }

  /**
   * Authenticate a WebSocket upgrade and tie the socket to its credential.
   * @returns whether the upgrade may proceed; otherwise the socket has been answered and closed.
   */
  admitUpgrade(request: IncomingMessage, socket: Duplex): boolean {
    const presented = presentedToken(request, this.trust.secure(request));
    const credential =
      presented === undefined ? undefined : this.credentialFor(presented.token, request);
    if (credential !== undefined) {
      this.connections.track(credential, socket);
      this.trust.authenticated(request);
      return true;
    }
    const status = presented === undefined ? 401 : this.countFailure(request);
    socket.write(
      `HTTP/1.1 ${status === 429 ? "429 Too Many Requests" : "401 Unauthorized"}\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
    return false;
  }

  private admit(
    request: IncomingMessage,
    response: ServerResponse,
    credential: string,
  ): RequestAuth {
    this.trust.authenticated(request);
    return {
      credential,
      local: isLocalConnection(request),
      release: this.connections.track(credential, response),
    };
  }

  /** Count an invalid token unless the address is already blocked. */
  private countFailure(request: IncomingMessage): 401 | 429 {
    const address = this.trust.clientAddress(request);
    if (this.limit.blocked(address)) return 429;
    this.limit.fail(address);
    return 401;
  }

  /** Handle `?token=` on a document request. @returns true when the response was written. */
  private exchange(request: IncomingMessage, response: ServerResponse): boolean {
    const url = new URL(request.url ?? "/", "http://local");
    const token = url.searchParams.get("token");
    if (token === null) return false;
    const accepted = this.tokens.isLocalToken(token) && isLocalConnection(request);
    if (!accepted) {
      const status = this.countFailure(request);
      this.signInPage(request, response, status, status === 429 ? "limited" : "queryToken");
      return true;
    }
    url.searchParams.delete("token");
    response
      .writeHead(302, {
        "set-cookie": this.cookie(request, token, COOKIE_MAX_AGE_SECONDS),
        location: `${url.pathname}${url.search}`,
        "cache-control": "no-store",
      })
      .end();
    return true;
  }

  private serveLogout(request: IncomingMessage, response: ServerResponse): void {
    request.resume();
    const sameOrigin = this.trust.sameOrigin(request);
    response
      .writeHead(sameOrigin ? 200 : 403, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...(sameOrigin ? { "set-cookie": this.cookie(request, "", 0) } : {}),
      })
      .end(JSON.stringify(sameOrigin ? { ok: true } : { error: { code: "auth/cross-origin" } }));
  }

  private async serveLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown, cookie?: string): void => {
      response
        .writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...(cookie === undefined ? {} : { "set-cookie": cookie }),
        })
        .end(JSON.stringify(body));
    };
    const fail = (status: number, code: string): void => {
      request.resume();
      reply(status, { error: { code } });
    };
    if (!this.trust.sameOrigin(request)) {
      fail(403, "auth/cross-origin");
      return;
    }
    if (this.limit.blocked(this.trust.clientAddress(request))) {
      fail(429, "auth/rate-limited");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += (chunk as Buffer).length;
      if (size > LOGIN_BODY_LIMIT_BYTES) {
        fail(413, "auth/request-too-large");
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let token: unknown;
    try {
      token = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { token?: unknown }).token;
    } catch {
      token = undefined;
    }
    if (typeof token !== "string" || this.credentialFor(token, request) === undefined) {
      this.countFailure(request);
      reply(401, { error: { code: "auth/invalid-token" } });
      return;
    }
    this.trust.authenticated(request);
    reply(200, { ok: true }, this.cookie(request, token, COOKIE_MAX_AGE_SECONDS));
  }
}
