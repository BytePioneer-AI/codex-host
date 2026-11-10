import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";
import { withRemoteAppServerSocketInitializationLock as withFileMutationLock } from "./remote-socket-lock.js";
import {
  codexhostDataDirectory,
  type AuthenticatedClient,
  type ExternalClientRegistry,
} from "./external-clients.js";

const PAIRING_PREFIX = "chp_";
const ACCESS_TOKEN_PREFIX = "choa_";
const REFRESH_TOKEN_PREFIX = "chor_";
const AUTH_CODE_PREFIX = "choc_";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_PAIRING_FAILURES = 5;
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredPairingCode {
  client: string;
  salt: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  failures: number;
}

interface StoredOAuthToken {
  client: string;
  oauthClientId?: string;
  salt: string;
  accessTokenHash: string;
  accessExpiresAt: string;
  refreshTokenHash: string;
  refreshExpiresAt: string;
  createdAt: string;
}

interface StoredDynamicClient {
  clientId: string;
  redirectUris: string[];
  createdAt: string;
}

interface StoredAuthorizationCode {
  client: string;
  oauthClientId: string;
  redirectUri: string;
  codeChallenge: string;
  salt: string;
  codeHash: string;
  expiresAt: string;
}

interface OAuthFile {
  formatVersion: 1;
  pairings: StoredPairingCode[];
  tokens: StoredOAuthToken[];
  dynamicClients?: StoredDynamicClient[];
  authorizationCodes?: StoredAuthorizationCode[];
}

export function defaultExternalClientOAuthPath(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), "external-client-oauth.json");
}

function hashSecret(salt: string, secret: string): string {
  return createHash("sha256").update(salt).update(secret).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function pkceChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isValidRedirectUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Unauthenticated registrations are capped so the file cannot grow without bound. */
const MAX_DYNAMIC_CLIENTS = 64;

/**
 * Appends a registration, evicting the oldest ones that no token or authorization code
 * uses once the cap is reached. Registrations in use are always kept.
 */
function boundedDynamicClients(data: OAuthFile, added: StoredDynamicClient): StoredDynamicClient[] {
  const inUse = new Set<string>([
    ...data.tokens.flatMap((token) => (token.oauthClientId ? [token.oauthClientId] : [])),
    ...(data.authorizationCodes ?? []).map((code) => code.oauthClientId),
  ]);
  const clients = [...(data.dynamicClients ?? []), added];
  let excess = clients.length - MAX_DYNAMIC_CLIENTS;
  return clients.filter((client) => {
    if (excess <= 0 || client === added || inUse.has(client.clientId)) return true;
    excess -= 1;
    return false;
  });
}

/**
 * Persistent store for one-time pairing codes, authorization codes, dynamic
 * OAuth client registrations, and hashed access/refresh tokens.
 */
export class ExternalClientOAuthStore {
  readonly #filePath: string;
  readonly #now: () => Date;

  constructor(filePath: string, now: () => Date = () => new Date()) {
    this.#filePath = filePath;
    this.#now = now;
  }

  /** Serializes short file transactions with the Host's cross-process filesystem lock. */
  async #mutate<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    return withFileMutationLock(this.#filePath, action);
  }

  /** Creates a 10-minute single-use pairing code for a registered external client. */
  async createPairingCode(
    client: string,
    now: Date = this.#now(),
  ): Promise<{ client: string; code: string; expiresAt: string }> {
    return this.#mutate(async () => {
      const data = await this.#read(now);
      const code = `${PAIRING_PREFIX}${randomBytes(12).toString("base64url")}`;
      const salt = randomBytes(16).toString("hex");
      const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
      const entry: StoredPairingCode = {
        client,
        salt,
        codeHash: hashSecret(salt, code),
        createdAt: now.toISOString(),
        expiresAt,
        failures: 0,
      };
      data.pairings = [...data.pairings.filter((item) => item.client !== client), entry];
      await this.#write(data);
      return { client, code, expiresAt };
    });
  }

  /** Removes all pairing codes and OAuth tokens for a revoked client. */
  async revokeClient(client: string): Promise<void> {
    return this.#mutate(async () => {
      const data = await this.#read(this.#now());
      const pairings = data.pairings.filter((item) => item.client !== client);
      const tokens = data.tokens.filter((item) => item.client !== client);
      const authorizationCodes = (data.authorizationCodes ?? []).filter(
        (item) => item.client !== client,
      );
      if (
        pairings.length !== data.pairings.length ||
        tokens.length !== data.tokens.length ||
        authorizationCodes.length !== (data.authorizationCodes ?? []).length
      ) {
        await this.#write({ ...data, pairings, tokens, authorizationCodes });
      }
    });
  }

  /** Registers a dynamic OAuth client (RFC 7591). */
  async registerDynamicClient(
    redirectUris: string[],
    now: Date = this.#now(),
  ): Promise<{ clientId: string; issuedAt: number; redirectUris: string[] }> {
    return this.#mutate(async () => {
      if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        redirectUris.some((uri) => typeof uri !== "string" || !isValidRedirectUri(uri))
      ) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "redirect_uris must be a non-empty array of valid URLs",
        );
      }
      const data = await this.#read(now);
      const clientId = `dyn_${randomBytes(16).toString("base64url")}`;
      const dynamicClients = boundedDynamicClients(data, {
        clientId,
        redirectUris,
        createdAt: now.toISOString(),
      });
      await this.#write({ ...data, dynamicClients });
      return {
        clientId,
        issuedAt: Math.floor(now.getTime() / 1000),
        redirectUris,
      };
    });
  }

  /** Validates whether a client_id + redirect_uri pair is permitted. */
  async validateRedirectUri(oauthClientId: string, redirectUri: string): Promise<boolean> {
    if (!oauthClientId || !isValidRedirectUri(redirectUri)) return false;
    const data = await this.#read(this.#now());
    const registered = (data.dynamicClients ?? []).find((item) => item.clientId === oauthClientId);
    return registered ? registered.redirectUris.includes(redirectUri) : true;
  }

  /**
   * Verifies and consumes a one-time pairing code, or records a failed attempt.
   * After 5 consecutive failures for a client's active pairing code, that code
   * is invalidated and must be regenerated.
   */
  async redeemPairingCode(input: {
    pairingCode: string;
    oauthClientId: string;
    redirectUri: string;
    codeChallenge: string;
    now?: Date;
  }): Promise<string | undefined> {
    return this.#mutate(async () => {
      const now = input.now ?? this.#now();
      const data = await this.#read(now);
      const trimmed = input.pairingCode.trim();
      let matched: StoredPairingCode | undefined;
      if (trimmed.startsWith(PAIRING_PREFIX)) {
        for (const entry of data.pairings) {
          if (sameHash(hashSecret(entry.salt, trimmed), entry.codeHash)) {
            matched = entry;
          }
        }
      }
      if (!matched) {
        // Increment failure count on active pairing codes; drop any that hit MAX_PAIRING_FAILURES.
        data.pairings = data.pairings
          .map((entry) => ({ ...entry, failures: entry.failures + 1 }))
          .filter((entry) => entry.failures < MAX_PAIRING_FAILURES);
        await this.#write(data);
        return undefined;
      }
      // Consume the pairing code so it can never be reused.
      data.pairings = data.pairings.filter((entry) => entry !== matched);
      const authCode = `${AUTH_CODE_PREFIX}${randomBytes(24).toString("base64url")}`;
      const salt = randomBytes(16).toString("hex");
      const authorizationCodes: StoredAuthorizationCode[] = [
        ...(data.authorizationCodes ?? []),
        {
          client: matched.client,
          oauthClientId: input.oauthClientId,
          redirectUri: input.redirectUri,
          codeChallenge: input.codeChallenge,
          salt,
          codeHash: hashSecret(salt, authCode),
          expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS).toISOString(),
        },
      ];
      await this.#write({ ...data, authorizationCodes });
      return authCode;
    });
  }

  /** Exchanges a single-use authorization code + PKCE verifier for access and refresh tokens. */
  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    oauthClientId?: string;
    redirectUri?: string;
    clients: ExternalClientRegistry;
    now?: Date;
  }): Promise<
    | {
        client: string;
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        scope: string;
      }
    | undefined
  > {
    return this.#mutate(async () => {
      const now = input.now ?? this.#now();
      const data = await this.#read(now);
      if (!input.code.startsWith(AUTH_CODE_PREFIX) || !input.codeVerifier) return undefined;
      let matched: StoredAuthorizationCode | undefined;
      for (const entry of data.authorizationCodes ?? []) {
        if (sameHash(hashSecret(entry.salt, input.code), entry.codeHash)) {
          matched = entry;
        }
      }
      if (!matched) return undefined;
      // Always consume the authorization code on first use attempt.
      data.authorizationCodes = (data.authorizationCodes ?? []).filter(
        (entry) => entry !== matched,
      );
      await this.#write(data);

      // Both were bound when the code was issued; a missing value must not skip the check.
      if (input.oauthClientId !== matched.oauthClientId) return undefined;
      if (input.redirectUri !== matched.redirectUri) return undefined;
      if (pkceChallengeS256(input.codeVerifier) !== matched.codeChallenge) return undefined;

      const registered = (await input.clients.list()).find((item) => item.name === matched.client);
      if (!registered || !registered.networks.includes("public")) return undefined;

      return this.#issueTokens(data, matched.client, registered.scope, matched.oauthClientId, now);
    });
  }

  /** Exchanges a valid refresh token for a new access and refresh token pair. */
  async exchangeRefreshToken(input: {
    refreshToken: string;
    oauthClientId?: string;
    clients: ExternalClientRegistry;
    now?: Date;
  }): Promise<
    | {
        client: string;
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        scope: string;
      }
    | undefined
  > {
    return this.#mutate(async () => {
      const now = input.now ?? this.#now();
      const data = await this.#read(now);
      if (!input.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return undefined;
      let matched: StoredOAuthToken | undefined;
      for (const entry of data.tokens) {
        if (sameHash(hashSecret(entry.salt, input.refreshToken), entry.refreshTokenHash)) {
          matched = entry;
        }
      }
      if (!matched) return undefined;
      data.tokens = data.tokens.filter((entry) => entry !== matched);
      await this.#write(data);

      if (
        input.oauthClientId &&
        matched.oauthClientId &&
        input.oauthClientId !== matched.oauthClientId
      ) {
        return undefined;
      }
      const registered = (await input.clients.list()).find((item) => item.name === matched.client);
      if (!registered || !registered.networks.includes("public")) return undefined;

      return this.#issueTokens(data, matched.client, registered.scope, matched.oauthClientId, now);
    });
  }

  /** Authenticates an OAuth access token against the current client registry. */
  async authenticateAccessToken(
    token: string | undefined,
    clients: ExternalClientRegistry,
    now: Date = this.#now(),
  ): Promise<AuthenticatedClient | undefined> {
    if (!token?.startsWith(ACCESS_TOKEN_PREFIX)) return undefined;
    const data = await this.#read(now);
    let matched: StoredOAuthToken | undefined;
    for (const entry of data.tokens) {
      if (
        Date.parse(entry.accessExpiresAt) > now.getTime() &&
        sameHash(hashSecret(entry.salt, token), entry.accessTokenHash)
      ) {
        matched = entry;
      }
    }
    if (!matched) return undefined;
    const registered = (await clients.list()).find((item) => item.name === matched.client);
    if (!registered) return undefined;
    return {
      name: registered.name,
      scope: registered.scope,
      networks: registered.networks,
    };
  }

  async #issueTokens(
    data: OAuthFile,
    client: string,
    scope: string,
    oauthClientId: string | undefined,
    now: Date,
  ): Promise<{
    client: string;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    scope: string;
  }> {
    const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const salt = randomBytes(16).toString("hex");
    const record: StoredOAuthToken = {
      client,
      ...(oauthClientId ? { oauthClientId } : {}),
      salt,
      accessTokenHash: hashSecret(salt, accessToken),
      accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
      refreshTokenHash: hashSecret(salt, refreshToken),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    };
    data.tokens = [...data.tokens, record];
    await this.#write(data);
    return {
      client,
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      scope,
    };
  }

  async #read(now: Date): Promise<OAuthFile> {
    const nowMs = now.getTime();
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as Partial<OAuthFile>;
      if (parsed?.formatVersion !== 1) {
        return { formatVersion: 1, pairings: [], tokens: [] };
      }
      const pairings = Array.isArray(parsed.pairings)
        ? parsed.pairings.filter(
            (entry) =>
              typeof entry?.client === "string" &&
              typeof entry.salt === "string" &&
              typeof entry.codeHash === "string" &&
              typeof entry.expiresAt === "string" &&
              Date.parse(entry.expiresAt) > nowMs &&
              typeof entry.failures === "number" &&
              entry.failures < MAX_PAIRING_FAILURES,
          )
        : [];
      const tokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter(
            (entry) =>
              typeof entry?.client === "string" &&
              typeof entry.salt === "string" &&
              typeof entry.accessTokenHash === "string" &&
              typeof entry.accessExpiresAt === "string" &&
              typeof entry.refreshTokenHash === "string" &&
              typeof entry.refreshExpiresAt === "string" &&
              Date.parse(entry.refreshExpiresAt) > nowMs,
          )
        : [];
      const dynamicClients = Array.isArray(parsed.dynamicClients) ? parsed.dynamicClients : [];
      const authorizationCodes = Array.isArray(parsed.authorizationCodes)
        ? parsed.authorizationCodes.filter(
            (entry) =>
              typeof entry?.client === "string" &&
              typeof entry.expiresAt === "string" &&
              Date.parse(entry.expiresAt) > nowMs,
          )
        : [];
      return { formatVersion: 1, pairings, tokens, dynamicClients, authorizationCodes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { formatVersion: 1, pairings: [], tokens: [] };
      }
      throw error;
    }
  }

  async #write(data: OAuthFile): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
