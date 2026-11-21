import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "./delegation-control-server.js";
import type { ExternalClientRegistry } from "./external-clients.js";
import type { ExternalClientOAuthStore } from "./external-client-oauth.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const AUTHORIZE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function renderAuthorizePage(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  error?: string;
}): string {
  const errorBlock = input.error
    ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize External Client · codexhost</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #faf9f5; color: #141413; margin: 0; padding: 48px 16px; }
    main { max-width: 420px; margin: 0 auto; background: #ffffff; border: 1px solid #e6e4dd; border-radius: 12px; padding: 24px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { font-size: 14px; color: #5e5d59; line-height: 1.5; margin: 0 0 16px; }
    p.error { color: #b42318; background: #fef3f2; border: 1px solid #fecdca; border-radius: 8px; padding: 10px 12px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d5d3cb; border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; margin-bottom: 16px; }
    button { width: 100%; padding: 10px 14px; border: 0; border-radius: 8px; background: #c96442; color: #ffffff; font-size: 14px; font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Pair External Client</h1>
    <p>Enter the one-time pairing code generated on your machine with <code>codexhost client pair &lt;name&gt;</code>.</p>
    ${errorBlock}
    <form method="post" action="authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(input.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(input.redirectUri)}">
      <input type="hidden" name="response_type" value="code">
      <input type="hidden" name="state" value="${escapeHtml(input.state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(input.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(input.codeChallengeMethod)}">
      <label for="pairing_code">Pairing Code</label>
      <input id="pairing_code" name="pairing_code" type="password" autocomplete="one-time-code" required autofocus>
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>
`;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "content-security-policy": AUTHORIZE_CSP,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(html);
}

async function readBodyText(request: IncomingMessage, maxBytes = 16 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readFormOrJson(request: IncomingMessage): Promise<Record<string, string>> {
  const raw = (await readBodyText(request)).trim();
  if (!raw) return {};
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

export function resolvePublicBaseUrl(
  request: IncomingMessage,
  configuredPublicUrl?: () => string | undefined,
): string {
  const configured = configuredPublicUrl?.();
  if (configured) return configured.replace(/\/+$/u, "");
  const protoHeader = request.headers["x-forwarded-proto"];
  const firstProto = typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : "";
  const proto = firstProto || "http";
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "127.0.0.1";
  const hostValue = Array.isArray(host) ? host[0] : host;
  return `${proto}://${hostValue}`;
}

export function stripPublicPrefix(pathname: string): string {
  if (pathname === "/codexhost") return "/";
  if (pathname.startsWith("/codexhost/")) return pathname.slice("/codexhost".length);
  return pathname;
}

/**
 * Handles unauthenticated OAuth discovery, registration, authorization page,
 * and token exchange routes on the `public` listener. Returns `true` when the
 * request matched an OAuth route and was answered.
 */
export async function handlePublicOAuthRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  oauth: ExternalClientOAuthStore;
  clients: ExternalClientRegistry;
  publicBaseUrl?: () => string | undefined;
}): Promise<boolean> {
  const { request, response, oauth, clients } = input;
  const pathname = stripPublicPrefix(input.url.pathname);
  const base = resolvePublicBaseUrl(request, input.publicBaseUrl);

  if (
    request.method === "GET" &&
    (pathname === "/.well-known/oauth-protected-resource" ||
      pathname === "/.well-known/oauth-protected-resource/mcp" ||
      pathname === "/.well-known/oauth-protected-resource/codexhost" ||
      pathname === "/.well-known/oauth-protected-resource/codexhost/mcp")
  ) {
    writeJson(response, 200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
    });
    return true;
  }

  if (
    request.method === "GET" &&
    (pathname === "/.well-known/oauth-authorization-server" ||
      pathname === "/.well-known/oauth-authorization-server/codexhost" ||
      pathname === "/.well-known/openid-configuration" ||
      pathname === "/.well-known/openid-configuration/codexhost")
  ) {
    writeJson(response, 200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
    return true;
  }

  if (pathname === "/oauth/register") {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "invalid_request", error_description: "POST is required" });
      return true;
    }
    try {
      const body = JSON.parse((await readBodyText(request)) || "{}") as {
        redirect_uris?: unknown;
        client_name?: unknown;
      };
      const redirectUris = Array.isArray(body.redirect_uris)
        ? (body.redirect_uris as string[])
        : [];
      const registered = await oauth.registerDynamicClient(redirectUris);
      writeJson(response, 201, {
        client_id: registered.clientId,
        client_id_issued_at: registered.issuedAt,
        redirect_uris: registered.redirectUris,
        ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    } catch (error) {
      writeJson(response, 400, {
        error: "invalid_client_metadata",
        error_description: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (pathname === "/oauth/authorize") {
    if (request.method === "GET") {
      const clientId = input.url.searchParams.get("client_id") ?? "";
      const redirectUri = input.url.searchParams.get("redirect_uri") ?? "";
      const responseType = input.url.searchParams.get("response_type") ?? "code";
      const state = input.url.searchParams.get("state") ?? "";
      const codeChallenge = input.url.searchParams.get("code_challenge") ?? "";
      const codeChallengeMethod = input.url.searchParams.get("code_challenge_method") ?? "S256";
      if (
        responseType !== "code" ||
        codeChallengeMethod !== "S256" ||
        !codeChallenge ||
        !(await oauth.validateRedirectUri(clientId, redirectUri))
      ) {
        sendHtml(
          response,
          400,
          renderAuthorizePage({
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            error:
              "Invalid OAuth authorization parameters (PKCE S256 and valid redirect_uri are required).",
          }),
        );
        return true;
      }
      sendHtml(
        response,
        200,
        renderAuthorizePage({
          clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
        }),
      );
      return true;
    }

    if (request.method === "POST") {
      const form = await readFormOrJson(request);
      const clientId = form.client_id ?? "";
      const redirectUri = form.redirect_uri ?? "";
      const responseType = form.response_type ?? "code";
      const state = form.state ?? "";
      const codeChallenge = form.code_challenge ?? "";
      const codeChallengeMethod = form.code_challenge_method ?? "S256";
      const pairingCode = form.pairing_code ?? "";
      if (
        responseType !== "code" ||
        codeChallengeMethod !== "S256" ||
        !codeChallenge ||
        !(await oauth.validateRedirectUri(clientId, redirectUri))
      ) {
        sendHtml(
          response,
          400,
          renderAuthorizePage({
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            error: "Invalid OAuth authorization parameters.",
          }),
        );
        return true;
      }
      const authCode = await oauth.redeemPairingCode({
        pairingCode,
        oauthClientId: clientId,
        redirectUri,
        codeChallenge,
      });
      if (!authCode) {
        sendHtml(
          response,
          400,
          renderAuthorizePage({
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            error: "Invalid or expired pairing code.",
          }),
        );
        return true;
      }
      const target = new URL(redirectUri);
      target.searchParams.set("code", authCode);
      if (state) target.searchParams.set("state", state);
      response.writeHead(303, {
        location: target.toString(),
        "cache-control": "no-store",
      });
      response.end();
      return true;
    }

    writeJson(response, 405, {
      error: "invalid_request",
      error_description: "GET or POST required",
    });
    return true;
  }

  if (pathname === "/oauth/token") {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "invalid_request", error_description: "POST is required" });
      return true;
    }
    const params = await readFormOrJson(request);
    const grantType = params.grant_type;
    if (grantType === "authorization_code") {
      const exchanged = await oauth.exchangeAuthorizationCode({
        code: params.code ?? "",
        codeVerifier: params.code_verifier ?? "",
        ...(params.client_id ? { oauthClientId: params.client_id } : {}),
        ...(params.redirect_uri ? { redirectUri: params.redirect_uri } : {}),
        clients,
      });
      if (!exchanged) {
        writeJson(response, 400, {
          error: "invalid_grant",
          error_description: "Authorization code or PKCE verifier is invalid or expired",
        });
        return true;
      }
      writeJson(response, 200, {
        access_token: exchanged.accessToken,
        token_type: "Bearer",
        expires_in: exchanged.expiresIn,
        refresh_token: exchanged.refreshToken,
        scope: exchanged.scope,
      });
      return true;
    }
    if (grantType === "refresh_token") {
      const refreshed = await oauth.exchangeRefreshToken({
        refreshToken: params.refresh_token ?? "",
        ...(params.client_id ? { oauthClientId: params.client_id } : {}),
        clients,
      });
      if (!refreshed) {
        writeJson(response, 400, {
          error: "invalid_grant",
          error_description: "Refresh token is invalid, expired, or revoked",
        });
        return true;
      }
      writeJson(response, 200, {
        access_token: refreshed.accessToken,
        token_type: "Bearer",
        expires_in: refreshed.expiresIn,
        refresh_token: refreshed.refreshToken,
        scope: refreshed.scope,
      });
      return true;
    }
    writeJson(response, 400, {
      error: "unsupported_grant_type",
      error_description: "Supported grant_types are authorization_code and refresh_token",
    });
    return true;
  }

  return false;
}
