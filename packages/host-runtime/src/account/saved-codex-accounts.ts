import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { codexAccountPlanTypeSchema } from "@codexhost/shared-contracts";

import {
  codexCredentialIdentitySchema,
  sameCodexCredentialIdentity,
  type CodexCredentialIdentity,
} from "./native-codex-credentials.js";

const savedAccountSchema = z
  .object({
    accountId: z.string().uuid(),
    identity: codexCredentialIdentitySchema,
    label: z.string().trim().min(1).max(256),
    email: z.string().email().max(320).optional(),
    planType: codexAccountPlanTypeSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
const registrySchema = z
  .object({
    formatVersion: z.literal(2),
    sharedCodexHome: z.string().min(1),
    currentAccountId: z.string().uuid().nullable(),
    accounts: z.array(savedAccountSchema).max(128),
  })
  .strict();

export type SavedCodexAccount = z.infer<typeof savedAccountSchema>;
type Registry = z.infer<typeof registrySchema>;

export class CodexAccountMigrationRequiredError extends Error {
  constructor() {
    super("Codex Account layout migration is required before using the shared home");
    this.name = "CodexAccountMigrationRequiredError";
  }
}

function validateRegistry(value: unknown): Registry {
  const parsed = registrySchema.safeParse(value);
  if (!parsed.success) throw new Error("Stored Codex Account metadata is invalid");
  const registry = parsed.data;
  if (!path.isAbsolute(registry.sharedCodexHome)) {
    throw new Error("Stored shared Codex home must be absolute");
  }
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const account of registry.accounts) {
    const identity = JSON.stringify([
      account.identity.issuer,
      account.identity.subject,
      account.identity.workspaceId,
    ]);
    if (ids.has(account.accountId) || identities.has(identity)) {
      throw new Error("Stored Codex Account metadata contains duplicate identities");
    }
    ids.add(account.accountId);
    identities.add(identity);
  }
  if (registry.currentAccountId !== null && !ids.has(registry.currentAccountId)) {
    throw new Error("Current Codex Account is not present in saved metadata");
  }
  return registry;
}

/** v2 non-secret registry. No per-Account home, Thread ownership or token storage. */
export class SavedCodexAccounts {
  readonly #file: string;
  readonly #sharedCodexHome: string;
  readonly #legacyRegistryFile: string | undefined;
  #registry: Registry | undefined;
  #initializing: Promise<void> | undefined;
  #mutations: Promise<void> = Promise.resolve();

  constructor(input: {
    directory: string;
    sharedCodexHome: string;
    legacyRegistryFile?: string;
  }) {
    if (!path.isAbsolute(input.sharedCodexHome)) {
      throw new Error("Shared Codex home must be absolute");
    }
    this.#sharedCodexHome = path.normalize(input.sharedCodexHome);
    this.#file = path.join(path.resolve(input.directory), "accounts.json");
    this.#legacyRegistryFile = input.legacyRegistryFile
      ? path.resolve(input.legacyRegistryFile)
      : undefined;
  }

  initialize(): Promise<void> {
    if (this.#registry) return Promise.resolve();
    if (this.#initializing) return this.#initializing;
    const initializing = this.#load();
    this.#initializing = initializing;
    void initializing.then(
      () => {
        this.#initializing = undefined;
      },
      () => {
        this.#initializing = undefined;
      },
    );
    return initializing;
  }

  list(): SavedCodexAccount[] {
    return structuredClone(this.#state().accounts);
  }

  getCurrentAccountId(): string | null {
    return this.#state().currentAccountId;
  }

  /** Call only after native authentication has confirmed the decoded identity. */
  async saveVerifiedAccount(input: {
    identity: CodexCredentialIdentity;
    preferredAccountId?: string;
    label?: string;
    email?: string;
    planType?: SavedCodexAccount["planType"];
  }): Promise<SavedCodexAccount> {
    const verified = structuredClone(input);
    return this.#mutate((registry) => {
      const previous = registry.accounts.find((a) =>
        sameCodexCredentialIdentity(a.identity, verified.identity),
      );
      const accountId = previous?.accountId ?? verified.preferredAccountId ?? randomUUID();
      const now = new Date().toISOString();
      const account = {
        ...previous,
        accountId,
        identity: { ...verified.identity },
        label: verified.label ?? previous?.label ?? `Codex Account ${accountId.slice(0, 8)}`,
        ...(verified.email === undefined ? {} : { email: verified.email }),
        ...(verified.planType === undefined ? {} : { planType: verified.planType }),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      const index = registry.accounts.findIndex((a) => a.accountId === accountId);
      if (index < 0) registry.accounts.push(account);
      else registry.accounts[index] = account;
      return account;
    });
  }

  /** The lifecycle owner commits this only after replacement identity verification. */
  async setCurrentAccountId(accountId: string | null): Promise<void> {
    await this.#mutate((registry) => {
      if (accountId !== null && !registry.accounts.some((a) => a.accountId === accountId)) {
        throw new Error("Cannot select an unknown Codex Account");
      }
      registry.currentAccountId = accountId;
    });
  }

  async remove(accountId: string): Promise<void> {
    await this.#mutate((registry) => {
      if (registry.currentAccountId === accountId)
        throw new Error("Current Codex Account cannot be deleted");
      if (!registry.accounts.some((a) => a.accountId === accountId))
        throw new Error("Unknown Codex Account");
      registry.accounts = registry.accounts.filter((a) => a.accountId !== accountId);
    });
  }

  async #load(): Promise<void> {
    let value: unknown;
    try {
      const serialized = await readFile(this.#file, "utf8");
      try {
        value = JSON.parse(serialized);
      } catch {
        throw new Error("Stored Codex Account metadata is invalid");
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      if (this.#legacyRegistryFile) {
        try {
          await readFile(this.#legacyRegistryFile);
          throw new CodexAccountMigrationRequiredError();
        } catch (legacyError) {
          if (
            legacyError instanceof CodexAccountMigrationRequiredError ||
            !(legacyError instanceof Error) ||
            !("code" in legacyError) ||
            legacyError.code !== "ENOENT"
          )
            throw legacyError;
        }
      }
      const initial: Registry = {
        formatVersion: 2,
        sharedCodexHome: this.#sharedCodexHome,
        currentAccountId: null,
        accounts: [],
      };
      await this.#persist(initial);
      this.#registry = initial;
      return;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "formatVersion" in value &&
      value.formatVersion === 1
    ) {
      throw new CodexAccountMigrationRequiredError();
    }
    const registry = validateRegistry(value);
    if (path.relative(registry.sharedCodexHome, this.#sharedCodexHome) !== "") {
      throw new Error("Shared Codex home does not match the saved registry");
    }
    this.#registry = registry;
  }

  #state(): Registry {
    if (!this.#registry) throw new Error("Saved Codex Accounts are not initialized");
    return this.#registry;
  }

  #mutate<T>(update: (registry: Registry) => T): Promise<T> {
    const pending = this.#mutations.then(async () => {
      const next = structuredClone(this.#state());
      const result = update(next);
      const validated = validateRegistry(next);
      await this.#persist(validated);
      // Failed persistence must not expose an uncommitted account or pointer.
      this.#registry = validated;
      return structuredClone(result);
    });
    this.#mutations = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #persist(registry: Registry): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
