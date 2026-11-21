import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";
import { withRemoteAppServerSocketInitializationLock as withFileMutationLock } from "./remote-socket-lock.js";

/** `read` observes; `dispatch` may also start, steer, cancel and watch work. */
export type ClientScope = "read" | "dispatch";
/** Which listener a request arrived on. */
export type ClientNetwork = "local" | "tailnet" | "public";

export const CLIENT_SCOPES: readonly ClientScope[] = ["read", "dispatch"];
export const CLIENT_NETWORKS: readonly ClientNetwork[] = ["local", "tailnet", "public"];

export interface ClientAccess {
  scope: ClientScope;
  networks: ClientNetwork[];
}

/** Clients registered before scopes existed keep what they could do then. */
const DEFAULT_ACCESS: ClientAccess = { scope: "dispatch", networks: ["local"] };

export interface ClientLastAccess {
  network: ClientNetwork;
  at: string;
}

/** A named process outside the Host that may call the delegation API with its own token. */
export interface ExternalClient extends ClientAccess {
  name: string;
  createdAt: string;
  lastAccess?: ClientLastAccess;
}

export interface AuthenticatedClient extends ClientAccess {
  name: string;
}

interface StoredClient extends Partial<ClientAccess> {
  name: string;
  createdAt: string;
  salt: string;
  /** sha256(salt + token), hex. Tokens are 32 random bytes, so a fast hash is sufficient. */
  tokenHash: string;
  lastAccess?: ClientLastAccess;
}

interface ClientsFile {
  formatVersion: 1;
  clients: StoredClient[];
}

const CLIENT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const LOCAL_CLI_CLIENT_NAME = "local-cli";

export function isValidClientName(name: string): boolean {
  return CLIENT_NAME.test(name);
}
const TOKEN_PREFIX = "chc_";

export function codexhostDataDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
}

export function defaultExternalClientsPath(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), "external-clients.json");
}

function hashToken(salt: string, token: string): string {
  return createHash("sha256").update(salt).update(token).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const LAST_ACCESS_THROTTLE_MS = 5_000;

function isValidLastAccess(value: unknown): value is ClientLastAccess {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ClientLastAccess>;
  return (
    typeof candidate.network === "string" &&
    CLIENT_NETWORKS.includes(candidate.network) &&
    typeof candidate.at === "string"
  );
}

function parseClientsFile(text: string): ClientsFile {
  const value = JSON.parse(text) as Partial<ClientsFile> | null;
  if (value?.formatVersion !== 1 || !Array.isArray(value.clients))
    throw new Error("unrecognized external client registry");
  for (const client of value.clients) {
    if (
      typeof client?.name !== "string" ||
      !CLIENT_NAME.test(client.name) ||
      typeof client.createdAt !== "string" ||
      typeof client.salt !== "string" ||
      typeof client.tokenHash !== "string" ||
      (client.scope !== undefined && !CLIENT_SCOPES.includes(client.scope)) ||
      (client.networks !== undefined &&
        (!Array.isArray(client.networks) ||
          client.networks.some((network) => !CLIENT_NETWORKS.includes(network)))) ||
      (client.lastAccess !== undefined && !isValidLastAccess(client.lastAccess))
    )
      throw new Error("unrecognized external client registry entry");
  }
  return value as ClientsFile;
}

/**
 * Registered external clients, kept in one private file. The CLI edits the file
 * directly, so registration works while no Runtime is running; a Runtime re-reads
 * it when it changes, so removal takes effect on the next request.
 */
export class ExternalClientRegistry {
  readonly #filePath: string;
  readonly #cliTokenHash: string | undefined;
  #cache: { mtimeMs: number; size: number; clients: StoredClient[] } | undefined;
  readonly #lastRecorded = new Map<string, { network: ClientNetwork; atMs: number }>();

  constructor(filePath: string, localCliToken?: string) {
    this.#filePath = filePath;
    this.#cliTokenHash = localCliToken ? hashToken("", localCliToken) : undefined;
  }

  async #mutate<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    return withFileMutationLock(this.#filePath, action);
  }

  async add(
    name: string,
    access: Partial<ClientAccess> = {},
    now: Date = new Date(),
  ): Promise<{ client: ExternalClient; token: string }> {
    if (!CLIENT_NAME.test(name))
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Client name must use lowercase letters, digits and hyphens, start and end with a letter or digit, and be at most 64 characters",
      );
    if (name === LOCAL_CLI_CLIENT_NAME)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Client name 'local-cli' is reserved for the local CLI",
      );
    return this.#mutate(async () => {
      const clients = await this.#read();
      if (clients.some((client) => client.name === name))
        throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' already exists`);
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const salt = randomBytes(16).toString("hex");
      const client: StoredClient = {
        name,
        createdAt: now.toISOString(),
        ...normalizeAccess({ ...DEFAULT_ACCESS, ...access }),
        salt,
        tokenHash: hashToken(salt, token),
      };
      await this.#write([...clients, client]);
      return { client: publicClient(client), token };
    });
  }

  async list(): Promise<ExternalClient[]> {
    return (await this.#read()).map(publicClient);
  }

  /** Changes take effect on the next request; streams on networks no longer allowed are closed. */
  async setAccess(name: string, access: Partial<ClientAccess>): Promise<ExternalClient> {
    return this.#mutate(async () => {
      const clients = await this.#read();
      const current = clients.find((client) => client.name === name);
      if (!current)
        throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' does not exist`);
      const updated: StoredClient = {
        ...current,
        ...normalizeAccess({ ...accessOf(current), ...access }),
      };
      await this.#write(clients.map((client) => (client.name === name ? updated : client)));
      return publicClient(updated);
    });
  }

  async remove(name: string): Promise<void> {
    return this.#mutate(async () => {
      const clients = await this.#read();
      if (!clients.some((client) => client.name === name))
        throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' does not exist`);
      await this.#write(clients.filter((client) => client.name !== name));
    });
  }

  /** The client the token belongs to, or undefined. Every entry is compared, so timing reveals nothing. */
  async authenticate(token: string | undefined): Promise<AuthenticatedClient | undefined> {
    if (!token?.startsWith(TOKEN_PREFIX)) return undefined;
    let match: StoredClient | undefined;
    for (const client of await this.#current()) {
      if (sameHash(hashToken(client.salt, token), client.tokenHash)) match = client;
    }
    if (match) return { name: match.name, ...accessOf(match) };
    return this.#cliTokenHash && sameHash(hashToken("", token), this.#cliTokenHash)
      ? { name: LOCAL_CLI_CLIENT_NAME, ...DEFAULT_ACCESS }
      : undefined;
  }

  /** Whether a client is still registered (and allowed on the network); ends streams otherwise. */
  async has(name: string, network?: ClientNetwork): Promise<boolean> {
    if (name === LOCAL_CLI_CLIENT_NAME && this.#cliTokenHash !== undefined)
      return network === undefined || network === "local";
    const client = (await this.#current()).find((candidate) => candidate.name === name);
    return !!client && (network === undefined || accessOf(client).networks.includes(network));
  }

  /** Records when and on which listener a client last made an allowed request. */
  async recordAccess(name: string, network: ClientNetwork, now: Date = new Date()): Promise<void> {
    if (name === LOCAL_CLI_CLIENT_NAME) return;
    const previous = this.#lastRecorded.get(name);
    if (previous?.network === network && now.getTime() - previous.atMs < LAST_ACCESS_THROTTLE_MS) {
      return;
    }
    return this.#mutate(async () => {
      const clients = await this.#read();
      const current = clients.find((client) => client.name === name);
      if (!current) return;
      const lastAccess: ClientLastAccess = { network, at: now.toISOString() };
      await this.#write(
        clients.map((client) => (client.name === name ? { ...client, lastAccess } : client)),
      );
      this.#lastRecorded.set(name, { network, atMs: now.getTime() });
    });
  }

  async #current(): Promise<StoredClient[]> {
    let info: { mtimeMs: number; size: number };
    try {
      info = await stat(this.#filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (this.#cache?.mtimeMs === info.mtimeMs && this.#cache.size === info.size)
      return this.#cache.clients;
    const clients = await this.#read();
    this.#cache = { mtimeMs: info.mtimeMs, size: info.size, clients };
    return clients;
  }

  async #read(): Promise<StoredClient[]> {
    try {
      return parseClientsFile(await readFile(this.#filePath, "utf8")).clients;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #write(clients: StoredClient[]): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const file: ClientsFile = { formatVersion: 1, clients };
    const temporary = `${this.#filePath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    this.#cache = undefined;
  }
}

function accessOf(client: StoredClient): ClientAccess {
  return {
    scope: client.scope ?? DEFAULT_ACCESS.scope,
    networks: client.networks ?? [...DEFAULT_ACCESS.networks],
  };
}

function publicClient(client: StoredClient): ExternalClient {
  return {
    name: client.name,
    createdAt: client.createdAt,
    ...accessOf(client),
    ...(client.lastAccess ? { lastAccess: client.lastAccess } : {}),
  };
}

function normalizeAccess(access: ClientAccess): ClientAccess {
  if (!CLIENT_SCOPES.includes(access.scope))
    throw new DelegationControlError("INVALID_ARGUMENT", "--scope must be read or dispatch");
  const networks = [...new Set(access.networks)];
  if (networks.length === 0 || networks.some((network) => !CLIENT_NETWORKS.includes(network)))
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--network must list one or more of local, tailnet, public",
    );
  return { scope: access.scope, networks };
}

export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}
