import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import lockfile from "proper-lockfile";

import { DelegationControlError } from "./delegation-types.js";

/** `read` observes; `dispatch` may also start, steer, answer, export, cancel and watch work. */
export type ClientScope = "read" | "dispatch";

const CLIENT_SCOPES: readonly ClientScope[] = ["read", "dispatch"];

/** New clients, clients registered before scopes existed, and the local CLI. */
const DEFAULT_SCOPE: ClientScope = "dispatch";

/** A named process outside the Host that may call the delegation API with its own token. */
export interface ExternalClient {
  name: string;
  createdAt: string;
  scope: ClientScope;
}

/** The caller a token belongs to. */
export interface AuthenticatedClient {
  name: string;
  scope: ClientScope;
}

interface StoredClient {
  name: string;
  createdAt: string;
  /** Absent for clients registered before scopes existed. */
  scope?: ClientScope;
  salt: string;
  /** sha256(salt + token), hex. Tokens are 32 random bytes, so a fast hash is sufficient. */
  tokenHash: string;
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
      (client.scope !== undefined && !CLIENT_SCOPES.includes(client.scope))
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

  constructor(filePath: string, localCliToken?: string) {
    this.#filePath = filePath;
    this.#cliTokenHash = localCliToken ? hashToken("", localCliToken) : undefined;
  }

  async add(
    name: string,
    scope: ClientScope = DEFAULT_SCOPE,
    now: Date = new Date(),
  ): Promise<{ client: ExternalClient; token: string }> {
    validScope(scope);
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
    return this.#mutate((clients) => {
      if (clients.some((client) => client.name === name))
        throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' already exists`);
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const salt = randomBytes(16).toString("hex");
      const client: StoredClient = {
        name,
        createdAt: now.toISOString(),
        scope,
        salt,
        tokenHash: hashToken(salt, token),
      };
      return { clients: [...clients, client], result: { client: publicClient(client), token } };
    });
  }

  async list(): Promise<ExternalClient[]> {
    return (await this.#read()).map(publicClient);
  }

  /** Takes effect on the client's next request; the token is unchanged. */
  async setScope(name: string, scope: ClientScope): Promise<ExternalClient> {
    validScope(scope);
    return this.#mutate((clients) => {
      const current = clients.find((client) => client.name === name);
      if (!current)
        throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' does not exist`);
      const updated: StoredClient = { ...current, scope };
      return {
        clients: clients.map((client) => (client.name === name ? updated : client)),
        result: publicClient(updated),
      };
    });
  }

  async remove(name: string): Promise<void> {
    await this.#mutate((clients) => {
      if (!clients.some((client) => client.name === name))
        throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' does not exist`);
      return { clients: clients.filter((client) => client.name !== name), result: undefined };
    });
  }

  /** The client the token belongs to, or undefined. Every entry is compared, so timing reveals nothing. */
  async authenticate(token: string | undefined): Promise<AuthenticatedClient | undefined> {
    if (!token?.startsWith(TOKEN_PREFIX)) return undefined;
    let match: AuthenticatedClient | undefined =
      this.#cliTokenHash && sameHash(hashToken("", token), this.#cliTokenHash)
        ? { name: LOCAL_CLI_CLIENT_NAME, scope: DEFAULT_SCOPE }
        : undefined;
    for (const client of await this.#current()) {
      if (sameHash(hashToken(client.salt, token), client.tokenHash))
        match = { name: client.name, scope: client.scope ?? DEFAULT_SCOPE };
    }
    return match;
  }

  /** Whether a client is still registered; used to end connections of removed clients. */
  async has(name: string): Promise<boolean> {
    return (
      (name === LOCAL_CLI_CLIENT_NAME && this.#cliTokenHash !== undefined) ||
      (await this.#current()).some((client) => client.name === name)
    );
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

  async #mutate<T>(
    update: (clients: StoredClient[]) => { clients: StoredClient[]; result: T },
  ): Promise<T> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    const release = await lockfile.lock(directory, {
      lockfilePath: `${this.#filePath}.lock`,
      retries: { retries: 24, minTimeout: 50, maxTimeout: 500 },
      onCompromised(error) {
        compromised = error;
      },
    });
    const assertLocked = () => {
      if (compromised) throw compromised;
    };
    try {
      const { clients, result } = update(await this.#read());
      await this.#write(clients, assertLocked);
      assertLocked();
      return result;
    } finally {
      if (!compromised) await release();
    }
  }

  async #write(clients: StoredClient[], assertLocked: () => void): Promise<void> {
    const file: ClientsFile = { formatVersion: 1, clients };
    const temporary = `${this.#filePath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      assertLocked();
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    this.#cache = undefined;
  }
}

function validScope(scope: string): asserts scope is ClientScope {
  if (!CLIENT_SCOPES.includes(scope as ClientScope))
    throw new DelegationControlError("INVALID_ARGUMENT", "--scope must be read or dispatch");
}

function publicClient(client: StoredClient): ExternalClient {
  return { name: client.name, createdAt: client.createdAt, scope: client.scope ?? DEFAULT_SCOPE };
}

export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}
