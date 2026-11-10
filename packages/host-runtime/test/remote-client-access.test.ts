import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import type { DelegationControlApi } from "../src/delegation-types.js";
import {
  ExternalClientOAuthStore,
  PAIRING_CODE_TTL_MS,
  defaultExternalClientOAuthPath,
} from "../src/external-client-oauth.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import {
  startExternalClientServer,
  type ExternalClientServer,
} from "../src/external-client-server.js";
import { ExternalClientRegistry } from "../src/external-clients.js";

describe("client scopes and networks", () => {
  let directory: string;
  let file: string;
  const servers: ExternalClientServer[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-access-"));
    file = path.join(directory, "external-clients.json");
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await rm(directory, { recursive: true, force: true });
  });

  it("consumes pairing, authorization and refresh grants once across processes", async () => {
    const clients = new ExternalClientRegistry(file);
    await clients.add("concurrent", { scope: "dispatch", networks: ["public"] });
    const oauthFile = path.join(directory, "oauth.json");
    const oauth = new ExternalClientOAuthStore(oauthFile);
    const { code: pairingCode } = await oauth.createPairingCode("concurrent");
    const codeVerifier = "v".repeat(64);
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const oauthModule = pathToFileURL(
      path.resolve(import.meta.dirname, "../src/external-client-oauth.ts"),
    ).href;
    const clientsModule = pathToFileURL(
      path.resolve(import.meta.dirname, "../src/external-clients.ts"),
    ).href;
    const source = `
      import { ExternalClientOAuthStore } from ${JSON.stringify(oauthModule)};
      import { ExternalClientRegistry } from ${JSON.stringify(clientsModule)};
      const [oauthFile, clientsFile, operation, raw] = process.argv.slice(1);
      const oauth = new ExternalClientOAuthStore(oauthFile);
      const clients = new ExternalClientRegistry(clientsFile);
      const input = JSON.parse(raw);
      const result = operation === "pair"
        ? await oauth.redeemPairingCode(input)
        : operation === "code"
          ? await oauth.exchangeAuthorizationCode({ ...input, clients })
          : await oauth.exchangeRefreshToken({ ...input, clients });
      process.stdout.write(JSON.stringify(result ?? null));
    `;
    const race = async (operation: string, input: Record<string, string>) => {
      const results = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const { stdout } = await promisify(execFile)(process.execPath, [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            source,
            oauthFile,
            file,
            operation,
            JSON.stringify(input),
          ]);
          return JSON.parse(stdout) as
            string | { accessToken: string; refreshToken: string } | null;
        }),
      );
      const successful = results.filter((result) => result !== null);
      expect(successful).toHaveLength(1);
      return successful[0];
    };
    const binding = { oauthClientId: "concurrent-mcp", redirectUri: "http://127.0.0.1/callback" };
    const code = await race("pair", { ...binding, pairingCode, codeChallenge });
    expect(typeof code).toBe("string");
    const tokens = await race("code", { ...binding, code: code as string, codeVerifier });
    expect(tokens).toHaveProperty("refreshToken");
    const original = tokens as { accessToken: string; refreshToken: string };
    const rotated = await race("refresh", {
      oauthClientId: binding.oauthClientId,
      refreshToken: original.refreshToken,
    });
    expect(await oauth.authenticateAccessToken(original.accessToken, clients)).toBeUndefined();
    expect(
      await oauth.authenticateAccessToken((rotated as typeof original).accessToken, clients),
    ).toMatchObject({ name: "concurrent" });
  }, 20_000);

  it("keeps clients registered before scopes at dispatch on the local network", async () => {
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        clients: [{ name: "old", createdAt: "2026-11-01T00:00:00Z", salt: "aa", tokenHash: "bb" }],
      }),
    );
    const registry = new ExternalClientRegistry(file);
    await expect(registry.list()).resolves.toEqual([
      { name: "old", createdAt: "2026-11-01T00:00:00Z", scope: "dispatch", networks: ["local"] },
    ]);
    await expect(registry.has("old", "local")).resolves.toBe(true);
    await expect(registry.has("old", "tailnet")).resolves.toBe(false);
  });

  it("sets scope and networks from the CLI and validates them", async () => {
    const environment = { CODEXHOST_DATA_DIR: directory };
    const run = async (arguments_: string[]) => {
      const output = new PassThrough();
      const diagnosticOutput = new PassThrough();
      const code = await runDelegationCli({
        arguments: arguments_,
        environment,
        output,
        diagnosticOutput,
      });
      return { code, body: JSON.parse(String((code === 0 ? output : diagnosticOutput).read())) };
    };
    await expect(
      run(["client", "add", "bot", "--scope", "read", "--network", "local,tailnet"]),
    ).resolves.toMatchObject({
      code: 0,
      body: { name: "bot", scope: "read", networks: ["local", "tailnet"] },
    });
    await expect(run(["client", "set", "bot", "--scope", "dispatch"])).resolves.toMatchObject({
      body: { scope: "dispatch", networks: ["local", "tailnet"] },
    });
    for (const bad of [
      ["client", "set", "bot", "--scope", "admin"],
      ["client", "set", "bot", "--network", "lan"],
      ["client", "set", "bot"],
      ["client", "set", "missing", "--scope", "read"],
    ])
      await expect(run(bad), bad.join(" ")).resolves.toMatchObject({
        code: 1,
        body: { error: { code: "INVALID_ARGUMENT" } },
      });
  });

  it("lets a read client observe but not dispatch", async () => {
    const api = {
      listHarnesses: vi.fn(async () => ({ harnesses: [] })),
      list: vi.fn(async () => ({ threads: [], nextCursor: null })),
      start: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
    };
    const watchApi = { watch: vi.fn(), watches: vi.fn(async () => ({ watches: [] })) };
    const route = externalClientRouter({
      api: api as unknown as DelegationControlApi,
      watchApi: watchApi as never,
    });
    const call = { client: "viewer", scope: "read", network: "local" } as Parameters<
      typeof route
    >[0];
    await expect(route(call, "/v1/harness/list", {})).resolves.toEqual({ harnesses: [] });
    await expect(
      route(call, "/v1/thread/list", { limit: 1, sort: "created-desc" }),
    ).resolves.toBeDefined();
    await expect(route(call, "/v1/thread/watches", {})).resolves.toBeDefined();
    for (const blocked of [
      "/v1/delegate/start",
      "/v1/thread/send",
      "/v1/thread/cancel",
      "/v1/thread/watch",
    ])
      await expect(route(call, blocked, {}), blocked).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(api.start).not.toHaveBeenCalled();
    expect(watchApi.watch).not.toHaveBeenCalled();
  });

  it("refuses a client on a network it is not allowed, like an unknown token, and answers FORBIDDEN with 403", async () => {
    const registry = new ExternalClientRegistry(file);
    const { token } = await registry.add("bot", { scope: "read" });
    const server = await startExternalClientServer({
      port: 0,
      clients: registry,
      network: "tailnet",
      route: externalClientRouter({
        api: { listHarnesses: async () => ({ harnesses: [] }) } as never,
      }),
    });
    if (!server) throw new Error("listener did not start");
    servers.push(server);
    const post = (route: string) =>
      fetch(new URL(route, server.endpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });

    const refused = await post("/v1/harness/list");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Client token is missing or invalid" },
    });

    await registry.setAccess("bot", { networks: ["local", "tailnet"] });
    expect((await post("/v1/harness/list")).status).toBe(200);
    await expect(registry.list()).resolves.toMatchObject([
      {
        name: "bot",
        scope: "read",
        networks: ["local", "tailnet"],
        lastAccess: { network: "tailnet", at: expect.any(String) },
      },
    ]);
    const forbidden = await post("/v1/delegate/start");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("pairs over OAuth 2.1 + PKCE on the public listener, enforces pairing code limits, and revokes tokens on client removal", async () => {
    const environment = { CODEXHOST_DATA_DIR: directory };
    const run = async (arguments_: string[]) => {
      const output = new PassThrough();
      const diagnosticOutput = new PassThrough();
      const code = await runDelegationCli({
        arguments: arguments_,
        environment,
        output,
        diagnosticOutput,
      });
      return { code, body: JSON.parse(String((code === 0 ? output : diagnosticOutput).read())) };
    };

    const registry = new ExternalClientRegistry(file);
    await registry.add("secret-bot", { scope: "read", networks: ["local", "public"] });
    await registry.add("other-hidden-client", { scope: "dispatch", networks: ["local"] });

    let clockMs = Date.parse("2026-11-04T10:00:00Z");
    const oauth = new ExternalClientOAuthStore(
      defaultExternalClientOAuthPath(environment),
      () => new Date(clockMs),
    );
    const server = await startExternalClientServer({
      port: 0,
      clients: registry,
      oauth,
      network: "public",
      route: externalClientRouter({
        api: { listHarnesses: async () => ({ harnesses: [{ id: "codex" }] }) } as never,
      }),
    });
    if (!server) throw new Error("public listener did not start");
    servers.push(server);

    // 1. Unauthenticated request advertises protected resource metadata
    const unauth = await fetch(new URL("/v1/harness/list", server.endpoint), {
      method: "POST",
      body: "{}",
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain(
      `${server.endpoint}/.well-known/oauth-protected-resource`,
    );

    // 2. Discovery metadata & dynamic client registration
    const prm = (await (
      await fetch(new URL("/.well-known/oauth-protected-resource", server.endpoint))
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(prm).toMatchObject({
      resource: `${server.endpoint}/mcp`,
      authorization_servers: [server.endpoint],
    });
    const prmPathInserted = (await (
      await fetch(new URL("/.well-known/oauth-protected-resource/codexhost/mcp", server.endpoint))
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(prmPathInserted).toEqual(prm);
    const asm = (await (
      await fetch(new URL("/.well-known/oauth-authorization-server", server.endpoint))
    ).json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    expect(asm).toMatchObject({
      authorization_endpoint: `${server.endpoint}/oauth/authorize`,
      token_endpoint: `${server.endpoint}/oauth/token`,
      registration_endpoint: `${server.endpoint}/oauth/register`,
    });
    const asmPathInserted = (await (
      await fetch(new URL("/.well-known/oauth-authorization-server/codexhost", server.endpoint))
    ).json()) as typeof asm;
    expect(asmPathInserted).toEqual(asm);

    const redirectUri = "http://127.0.0.1:6274/oauth/callback";
    const regResponse = await fetch(new URL("/oauth/register", server.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "MCP Inspector" }),
    });
    expect(regResponse.status).toBe(201);
    const registeredClient = (await regResponse.json()) as { client_id: string };
    expect(registeredClient.client_id).toMatch(/^dyn_/u);

    // 3. Authorization page does not leak any client names, threads, or workspaces
    const verifier = "verifier-secret-value-for-pkce-s256-check-123456";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authUrl = new URL("/oauth/authorize", server.endpoint);
    authUrl.searchParams.set("client_id", registeredClient.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", "xyz-state");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    const pageRes = await fetch(authUrl);
    expect(pageRes.status).toBe(200);
    const pageHtml = await pageRes.text();
    expect(pageHtml).toContain("pairing_code");
    expect(pageHtml).not.toContain("secret-bot");
    expect(pageHtml).not.toContain("other-hidden-client");

    // 4. Pairing code expires after 10 minutes
    const expiredPair = await oauth.createPairingCode("secret-bot", new Date(clockMs));
    clockMs += PAIRING_CODE_TTL_MS + 1_000;
    const submitPairing = (pairingCode: string) =>
      fetch(new URL("/oauth/authorize", server.endpoint), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
        body: new URLSearchParams({
          client_id: registeredClient.client_id,
          redirect_uri: redirectUri,
          response_type: "code",
          state: "xyz-state",
          code_challenge: challenge,
          code_challenge_method: "S256",
          pairing_code: pairingCode,
        }),
      });
    expect((await submitPairing(expiredPair.code)).status).toBe(400);

    // 5. 5 consecutive failed attempts invalidate the active pairing code
    const LockoutPair = await oauth.createPairingCode("secret-bot", new Date(clockMs));
    for (let index = 0; index < 5; index += 1) {
      expect((await submitPairing(`chp_wrong_${index}`)).status).toBe(400);
    }
    expect((await submitPairing(LockoutPair.code)).status).toBe(400);

    // 6. CLI `codexhost client pair` generates a valid code; single-use + PKCE exchange
    const cliPaired = await run(["client", "pair", "secret-bot"]);
    expect(cliPaired.code).toBe(0);
    const validPairingCode = (cliPaired.body as { code: string }).code;
    // Align test clock with real clock since CLI used current time
    clockMs = Date.now();

    const authorized = await submitPairing(validPairingCode);
    expect(authorized.status).toBe(303);
    const location = new URL(authorized.headers.get("location") ?? "");
    expect(location.searchParams.get("state")).toBe("xyz-state");
    const authCode = location.searchParams.get("code") ?? "";
    expect(authCode).toMatch(/^choc_/u);

    // Reusing the same pairing code fails immediately
    expect((await submitPairing(validPairingCode)).status).toBe(400);

    // Exchange authorization code with PKCE verifier
    const tokenRes = await fetch(new URL("/oauth/token", server.endpoint), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        code_verifier: verifier,
        client_id: registeredClient.client_id,
        redirect_uri: redirectUri,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("read");

    // Reusing the authorization code fails
    const replayCode = await fetch(new URL("/oauth/token", server.endpoint), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        code_verifier: verifier,
        client_id: registeredClient.client_id,
        redirect_uri: redirectUri,
      }),
    });
    expect(replayCode.status).toBe(400);

    // 7. Call public endpoint with OAuth access token (inherits client 'read' scope)
    const allowedCall = await fetch(new URL("/v1/harness/list", server.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: "{}",
    });
    expect(allowedCall.status).toBe(200);
    expect(await allowedCall.json()).toEqual({ harnesses: [{ id: "codex" }] });

    const forbiddenDispatch = await fetch(new URL("/v1/delegate/start", server.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: "{}",
    });
    expect(forbiddenDispatch.status).toBe(403);

    // 8. Refresh token rotation
    const refreshRes = await fetch(new URL("/oauth/token", server.endpoint), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: registeredClient.client_id,
      }),
    });
    expect(refreshRes.status).toBe(200);
    const rotated = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    // 9. Revoking the client immediately invalidates both access and refresh tokens
    expect((await run(["client", "remove", "secret-bot"])).code).toBe(0);
    const afterRevoke = await fetch(new URL("/v1/harness/list", server.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${rotated.access_token}` },
      body: "{}",
    });
    expect(afterRevoke.status).toBe(401);

    const refreshAfterRevoke = await fetch(new URL("/oauth/token", server.endpoint), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rotated.refresh_token,
        client_id: registeredClient.client_id,
      }),
    });
    expect(refreshAfterRevoke.status).toBe(400);
  });
});
