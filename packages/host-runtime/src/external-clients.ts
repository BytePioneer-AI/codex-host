import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";

/** A named process outside the Host that may call the delegation API with its own token. */
export interface ExternalClient {
  name: string;
  createdAt: string;
}

interface StoredClient extends ExternalClient {
  salt: string;
  /** sha256(salt + token), hex. Tokens are 32 random bytes, so a fast hash is sufficient. */
  tokenHash: string;
}

interface ClientsFile {
  formatVersion: 1;
  clients: StoredClient[];
}

const CLIENT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

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
      typeof client.tokenHash !== "string"
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
  #cache: { mtimeMs: number; size: number; clients: StoredClient[] } | undefined;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async add(
    name: string,
    now: Date = new Date(),
  ): Promise<{ client: ExternalClient; token: string }> {
    if (!CLIENT_NAME.test(name))
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Client name must use lowercase letters, digits and hyphens, start and end with a letter or digit, and be at most 64 characters",
      );
    const clients = await this.#read();
    if (clients.some((client) => client.name === name))
      throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' already exists`);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const salt = randomBytes(16).toString("hex");
    const client: StoredClient = {
      name,
      createdAt: now.toISOString(),
      salt,
      tokenHash: hashToken(salt, token),
    };
    await this.#write([...clients, client]);
    return { client: { name, createdAt: client.createdAt }, token };
  }

  async list(): Promise<ExternalClient[]> {
    return (await this.#read()).map(({ name, createdAt }) => ({ name, createdAt }));
  }

  async remove(name: string): Promise<void> {
    const clients = await this.#read();
    if (!clients.some((client) => client.name === name))
      throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' does not exist`);
    await this.#write(clients.filter((client) => client.name !== name));
  }

  /** The client the token belongs to, or undefined. Every entry is compared, so timing reveals nothing. */
  async authenticate(token: string | undefined): Promise<string | undefined> {
    if (!token?.startsWith(TOKEN_PREFIX)) return undefined;
    let match: string | undefined;
    for (const client of await this.#current()) {
      if (sameHash(hashToken(client.salt, token), client.tokenHash)) match = client.name;
    }
    return match;
  }

  /** Whether a client is still registered; used to end connections of removed clients. */
  async has(name: string): Promise<boolean> {
    return (await this.#current()).some((client) => client.name === name);
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

export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}
