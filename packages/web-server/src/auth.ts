/**
 * Access-token authentication for the Web server.
 *
 * Every request needs the server's access token, supplied once as `?token=` (exchanged for an
 * HttpOnly cookie) or on each request as `Authorization: Bearer <token>` (native shells). Without
 * it the server answers a small sign-in page so a phone can paste the token by hand.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { DataDir } from "./store.ts";

const COOKIE = "codexhost_token";
const FILE = "auth.json";

export class AccessAuth {
  readonly token: string;

  constructor(data: DataDir, options: { rotate?: boolean; token?: string } = {}) {
    const stored = data.readJson<{ token?: string }>(FILE, {});
    let token = options.token ?? (options.rotate === true ? undefined : stored.token);
    if (token === undefined || token.length < 16) {
      token = randomBytes(24).toString("base64url");
    }
    if (token !== stored.token) data.writeJson(FILE, { token });
    this.token = token;
  }

  private matches(candidate: string | undefined): boolean {
    if (candidate === undefined) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Token presented by one request (cookie or bearer header). */
  private presented(request: IncomingMessage): string | undefined {
    const header = request.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer "))
      return header.slice("Bearer ".length).trim();
    const cookies = request.headers.cookie ?? "";
    for (const part of cookies.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === COOKIE) return decodeURIComponent(rest.join("="));
    }
    return undefined;
  }

  authorized(request: IncomingMessage): boolean {
    return this.matches(this.presented(request));
  }

  /**
   * Handle the `?token=` exchange on a document request.
   * @returns true when the response was written (redirect).
   */
  exchange(request: IncomingMessage, response: ServerResponse): boolean {
    const url = new URL(request.url ?? "/", "http://local");
    const token = url.searchParams.get("token");
    if (token === null) return false;
    if (!this.matches(token)) {
      this.signInPage(response, "That access token is not valid.");
      return true;
    }
    url.searchParams.delete("token");
    const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    response
      .writeHead(302, {
        "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
        location: `${url.pathname}${url.search}`,
        "cache-control": "no-store",
      })
      .end();
    return true;
  }

  signInPage(response: ServerResponse, message?: string): void {
    response.writeHead(401, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    }).end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodexHost</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#151517;--muted:#6b6b72;--line:#e3e3e8;--accent:#151517;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--fg:#f2f2f5;--muted:#9a9aa3;--line:#2c2c31;--accent:#f2f2f5;--accent-fg:#151517}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(360px,calc(100vw - 32px))}
h1{font-size:22px;margin:0 0 6px}
p{color:var(--muted);margin:0 0 20px}
input{box-sizing:border-box;width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:transparent;color:inherit;font:inherit}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600}
.err{color:#d92d20}
</style></head>
<body><main>
<h1>CodexHost</h1>
<p>Enter the access token printed by <code>codexhost web</code> on your computer.</p>
${message === undefined ? "" : `<p class="err">${message}</p>`}
<form method="get" action="./"><input name="token" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Access token" autofocus><button type="submit">Continue</button></form>
</main></body></html>`);
  }
}
