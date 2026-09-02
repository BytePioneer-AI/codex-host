import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

interface StoredThreadAccountsV1 {
  formatVersion: 1;
  bindings: Record<string, string>;
}

export interface ThreadAccountStoreLike {
  initialize(): Promise<void>;
  getAccountId(threadId: string): Promise<string | null>;
  bind(threadId: string, accountId: string): Promise<void>;
  listByAccount(accountId: string): Promise<string[]>;
  remove(threadId: string): Promise<void>;
}

/** Durable ownership index; it stores routing identities and never credentials. */
export class ThreadAccountStore implements ThreadAccountStoreLike {
  readonly #file: string;
  readonly #bindings = new Map<string, string>();
  #initialized = false;
  #writeTail = Promise.resolve();

  constructor(input: { directory: string }) {
    this.#file = path.join(path.resolve(input.directory), "thread-accounts.json");
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const stored = JSON.parse(await readFile(this.#file, "utf8")) as StoredThreadAccountsV1;
      if (stored.formatVersion !== 1 || !stored.bindings || typeof stored.bindings !== "object") {
        throw new Error("Unsupported Thread Account Store format");
      }
      for (const [threadId, accountId] of Object.entries(stored.bindings)) {
        if (!threadId || !accountId) throw new Error("Thread Account binding is invalid");
        this.#bindings.set(threadId, accountId);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.#persist();
    }
    this.#initialized = true;
  }

  async getAccountId(threadId: string): Promise<string | null> {
    this.#requireInitialized();
    return this.#bindings.get(threadId) ?? null;
  }

  async bind(threadId: string, accountId: string): Promise<void> {
    this.#requireInitialized();
    if (!threadId || !accountId) throw new Error("Thread Account binding must not be empty");
    const existing = this.#bindings.get(threadId);
    if (existing && existing !== accountId) {
      throw new Error(`Thread '${threadId}' is already bound to Codex Account '${existing}'`);
    }
    if (existing === accountId) return;
    this.#bindings.set(threadId, accountId);
    await this.#persist();
  }

  async listByAccount(accountId: string): Promise<string[]> {
    this.#requireInitialized();
    return [...this.#bindings]
      .filter(([, candidate]) => candidate === accountId)
      .map(([threadId]) => threadId);
  }

  async remove(threadId: string): Promise<void> {
    this.#requireInitialized();
    if (!this.#bindings.delete(threadId)) return;
    await this.#persist();
  }

  #requireInitialized(): void {
    if (!this.#initialized) throw new Error("Thread Account Store is not initialized");
  }

  #persist(): Promise<void> {
    const value: StoredThreadAccountsV1 = {
      formatVersion: 1,
      bindings: Object.fromEntries(this.#bindings),
    };
    const operation = this.#writeTail.then(async () => {
      const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#file);
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
