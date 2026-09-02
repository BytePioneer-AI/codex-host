import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface CodexAccount {
  accountId: string;
  codexHome: string;
  email?: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredAccountsV1 {
  formatVersion: 1;
  activeAccountId: string;
  accounts: CodexAccount[];
}

export interface AccountRepositoryLike {
  initialize(): Promise<void>;
  get(accountId: string): Promise<CodexAccount | null>;
  list(): Promise<CodexAccount[]>;
  getActiveAccountId(): Promise<string>;
  isDefaultAccount(accountId: string): boolean;
  setActiveAccountId(accountId: string): Promise<void>;
  remove(accountId: string): Promise<CodexAccount>;
  upsert(input: {
    accountId: string;
    codexHome: string;
    email?: string;
    label?: string;
  }): Promise<CodexAccount>;
}

function validateAccountId(accountId: string): void {
  if (!/^[A-Za-z0-9._~-]+$/u.test(accountId)) {
    throw new Error("Codex Account ID must be non-empty and filename-safe");
  }
}

function cloneAccount(account: CodexAccount): CodexAccount {
  return { ...account };
}

/** Persists account routing metadata only. Credentials remain owned by each CODEX_HOME. */
export class AccountRepository implements AccountRepositoryLike {
  readonly #file: string;
  readonly #defaultAccount: { accountId: string; codexHome: string; label: string };
  readonly #accounts = new Map<string, CodexAccount>();
  #activeAccountId = "";
  #initialized = false;
  #mutationTail = Promise.resolve();
  #writeTail = Promise.resolve();

  constructor(input: {
    directory: string;
    defaultAccount: { accountId: string; codexHome: string; label?: string };
  }) {
    this.#file = path.join(path.resolve(input.directory), "accounts.json");
    this.#defaultAccount = {
      ...input.defaultAccount,
      label: input.defaultAccount.label ?? input.defaultAccount.accountId,
    };
    validateAccountId(this.#defaultAccount.accountId);
    if (!path.isAbsolute(this.#defaultAccount.codexHome)) {
      throw new Error("Codex Account CODEX_HOME must be absolute");
    }
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(path.dirname(this.#file), { recursive: true });
    let stored: StoredAccountsV1 | null = null;
    try {
      stored = JSON.parse(await readFile(this.#file, "utf8")) as StoredAccountsV1;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (stored) {
      if (stored.formatVersion !== 1 || !Array.isArray(stored.accounts)) {
        throw new Error("Unsupported Codex Account Repository format");
      }
      for (const account of stored.accounts) this.#validateAccount(account);
      for (const account of stored.accounts) this.#accounts.set(account.accountId, account);
      if (!this.#accounts.has(stored.activeAccountId)) {
        throw new Error("Active Codex Account is not present in Account Repository");
      }
      this.#activeAccountId = stored.activeAccountId;
    } else {
      const now = new Date().toISOString();
      const account: CodexAccount = { ...this.#defaultAccount, createdAt: now, updatedAt: now };
      this.#accounts.set(account.accountId, account);
      this.#activeAccountId = account.accountId;
      await this.#persist();
    }
    this.#initialized = true;
  }

  async get(accountId: string): Promise<CodexAccount | null> {
    this.#requireInitialized();
    const account = this.#accounts.get(accountId);
    return account ? cloneAccount(account) : null;
  }

  async list(): Promise<CodexAccount[]> {
    this.#requireInitialized();
    return [...this.#accounts.values()].map(cloneAccount);
  }

  async getActiveAccountId(): Promise<string> {
    this.#requireInitialized();
    return this.#activeAccountId;
  }

  isDefaultAccount(accountId: string): boolean {
    return accountId === this.#defaultAccount.accountId;
  }

  async setActiveAccountId(accountId: string): Promise<void> {
    this.#requireInitialized();
    await this.#mutate(async () => {
      if (!this.#accounts.has(accountId)) throw new Error(`Unknown Codex Account '${accountId}'`);
      this.#activeAccountId = accountId;
      await this.#persist();
    });
  }

  async remove(accountId: string): Promise<CodexAccount> {
    this.#requireInitialized();
    if (this.isDefaultAccount(accountId))
      throw new Error("The default Codex Account cannot be deleted");
    return this.#mutate(async () => {
      const account = this.#accounts.get(accountId);
      if (!account) throw new Error(`Unknown Codex Account '${accountId}'`);
      this.#accounts.delete(accountId);
      if (this.#activeAccountId === accountId) {
        this.#activeAccountId = this.#defaultAccount.accountId;
      }
      await this.#persist();
      return cloneAccount(account);
    });
  }

  async upsert(input: {
    accountId: string;
    codexHome: string;
    email?: string;
    label?: string;
  }): Promise<CodexAccount> {
    this.#requireInitialized();
    validateAccountId(input.accountId);
    if (!path.isAbsolute(input.codexHome))
      throw new Error("Codex Account CODEX_HOME must be absolute");
    return this.#mutate(async () => {
      const previous = this.#accounts.get(input.accountId);
      const now = new Date().toISOString();
      const email = input.email ?? previous?.email;
      const account: CodexAccount = {
        accountId: input.accountId,
        codexHome: path.normalize(input.codexHome),
        ...(email ? { email } : {}),
        label: input.label ?? previous?.label ?? input.accountId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      this.#accounts.set(account.accountId, account);
      await this.#persist();
      return cloneAccount(account);
    });
  }

  #validateAccount(account: CodexAccount): void {
    validateAccountId(account.accountId);
    if (!path.isAbsolute(account.codexHome)) throw new Error("Stored CODEX_HOME must be absolute");
    if (account.email && (!account.email.includes("@") || account.email.length > 320)) {
      throw new Error("Stored Codex Account email is invalid");
    }
    if (
      !account.label ||
      Number.isNaN(Date.parse(account.createdAt)) ||
      Number.isNaN(Date.parse(account.updatedAt))
    ) {
      throw new Error("Stored Codex Account metadata is invalid");
    }
  }

  #requireInitialized(): void {
    if (!this.#initialized) throw new Error("Account Repository is not initialized");
  }

  #persist(): Promise<void> {
    const value: StoredAccountsV1 = {
      formatVersion: 1,
      activeAccountId: this.#activeAccountId,
      accounts: [...this.#accounts.values()],
    };
    const operation = this.#writeTail.then(async () => {
      const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#file);
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#mutationTail.then(operation);
    this.#mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
