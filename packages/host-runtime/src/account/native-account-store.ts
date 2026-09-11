import { randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { NativePrivateFileLease } from "../native-private-files.js";
import { NativeCodexCredentials, sameCodexCredentialIdentity } from "./native-codex-credentials.js";
import {
  NativeAccountError,
  nativeDigest,
  credentialDigest,
  parseVault,
  parseJournal,
  serializePrivate,
  sameVault,
  validateVault,
  encryptCredential,
  decryptCredential,
  parseProfileAccount,
  type NativeProfileVault,
  type NativeProfileAccount,
  type NativeProfileJournal,
  type EncryptedNativeCredential,
} from "./native-profile-vault.js";

export interface PrivateCredentialFiles {
  ensureDirectory(directory: string): Promise<void>;
  read(directory: string, name: string): Promise<Buffer | null>;
  replace(
    directory: string,
    name: string,
    content: Uint8Array,
    expected: string | null,
  ): Promise<void>;
  remove(directory: string, name: string, expected: string): Promise<void>;
  lock(directory: string, name: string): Promise<NativePrivateFileLease>;
}
export interface NativeAccountKeys {
  read(keyId: string): Promise<Buffer | null>;
  create(keyId: string): Promise<Buffer>;
}
const stageSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    sourceAccountId: z.string().uuid().nullable(),
    requestedAccountId: z.string().uuid().optional(),
    /** Native Desktop login changes current identity; Settings add may only save it. */
    activateOnSuccess: z.boolean().optional(),
    nativeLoginId: z.string().min(1).max(1024).optional(),
    /** Present only after a native login completion and stopped-file verification. */
    candidate: z.unknown().optional(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type NativeLoginStage = Omit<z.infer<typeof stageSchema>, "candidate"> & {
  candidate?: NativeProfileAccount;
};

/** Private persistence for one home. Only the account Module mutates Vault/Journal. */
export class NativeAccountStore {
  readonly home: string;
  readonly directory: string;
  readonly homeId: string;
  readonly files: PrivateCredentialFiles;
  readonly #homeFiles: PrivateCredentialFiles;
  readonly #keys: NativeAccountKeys;
  readonly #onLeaseLost: () => void;
  #lease: NativePrivateFileLease | undefined;
  #key: Buffer | undefined;
  #vault: NativeProfileVault | undefined;
  #mutations: Promise<void> = Promise.resolve();

  constructor(input: {
    home: string;
    files: PrivateCredentialFiles;
    homeFiles?: PrivateCredentialFiles;
    keys: NativeAccountKeys;
    onLeaseLost?: () => void;
  }) {
    this.home = path.resolve(input.home);
    this.directory = path.join(this.home, ".codexhost-native-accounts");
    this.homeId = nativeDigest(process.platform === "win32" ? this.home.toLowerCase() : this.home);
    this.files = input.files;
    this.#homeFiles = input.homeFiles ?? input.files;
    this.#keys = input.keys;
    this.#onLeaseLost = input.onLeaseLost ?? (() => {});
  }

  /** Native fallback may keep file/process ownership without decrypting any profile. */
  async open(options: { allowLocked?: boolean } = {}): Promise<boolean> {
    if (this.#lease) throw new NativeAccountError("recovery-required");
    await this.#homeFiles.ensureDirectory(this.home);
    await this.files.ensureDirectory(this.directory);
    const lease = await this.files.lock(this.directory, ".codexhost-writer.lock");
    this.#lease = lease;
    void lease.closed.then(() => {
      if (this.#lease !== lease) return;
      this.#lease = undefined;
      this.#key?.fill(0);
      this.#key = undefined;
      this.#onLeaseLost();
    });
    try {
      const bytes = await this.files.read(this.directory, "vault.json");
      const pending = await this.files.read(this.directory, "transaction.json");
      const stage = await this.files.read(this.directory, "login.json");
      if (!bytes && (pending || stage)) throw new NativeAccountError("recovery-required");
      if (bytes) this.#vault = parseVault(bytes, this.homeId);
      try {
        this.#key = (await this.#keys.read(this.homeId)) ?? undefined;
        if (!this.#key && !bytes) this.#key = await this.#keys.create(this.homeId);
        if (!this.#key || this.#key.length !== 32) throw new Error("key");
      } catch {
        this.#key?.fill(0);
        this.#key = undefined;
        if (options.allowLocked) return false;
        throw new NativeAccountError("keyring-unavailable");
      }
      if (!bytes) {
        const initial: NativeProfileVault = {
          version: 1,
          homeId: this.homeId,
          revision: 0,
          currentAccountId: null,
          lastOperationId: null,
          accounts: [],
        };
        await this.files.replace(this.directory, "vault.json", serializePrivate(initial), null);
        this.#vault = initial;
      }
      return true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  assertFileOwnership(): void {
    if (!this.#lease) throw new NativeAccountError("recovery-required");
  }
  assertOwnership(): void {
    this.#ownedKey();
  }
  #ownedKey(): Buffer {
    this.assertFileOwnership();
    if (!this.#key) throw new NativeAccountError("keyring-unavailable");
    return this.#key;
  }
  get vault(): NativeProfileVault {
    this.assertOwnership();
    if (!this.#vault) throw new NativeAccountError("recovery-required");
    return structuredClone(this.#vault);
  }
  async reload(): Promise<NativeProfileVault> {
    this.assertOwnership();
    const bytes = await this.files.read(this.directory, "vault.json");
    if (!bytes) throw new NativeAccountError("recovery-required");
    const observed = parseVault(bytes, this.homeId);
    if (this.#vault && observed.revision < this.#vault.revision)
      throw new NativeAccountError("credential-conflict");
    this.#vault = observed;
    return this.vault;
  }
  async replaceVault(next: NativeProfileVault, expected: NativeProfileVault): Promise<void> {
    this.assertOwnership();
    const validated = validateVault(next, this.homeId),
      content = serializePrivate(validated);
    const previous = await this.files.read(this.directory, "vault.json");
    if (!previous) throw new NativeAccountError("recovery-required");
    const actual = parseVault(previous, this.homeId);
    if (sameVault(actual, validated)) {
      this.#vault = actual;
      return;
    }
    if (!sameVault(actual, expected) || validated.revision !== expected.revision + 1)
      throw new NativeAccountError("credential-conflict");
    this.assertOwnership();
    try {
      await this.files.replace(this.directory, "vault.json", content, nativeDigest(previous));
    } finally {
      // A lost acknowledgement may follow durable rename. Re-read before exposing state.
      await this.reload();
    }
  }
  mutate(update: (next: NativeProfileVault) => void): Promise<void> {
    const pending = this.#mutations.then(async () => {
      if ((await this.readJournal()) || (await this.readStage()))
        throw new NativeAccountError("recovery-required");
      const before = await this.reload(),
        next = structuredClone(before);
      update(next);
      next.revision++;
      next.lastOperationId = randomUUID();
      await this.replaceVault(next, before);
    });
    this.#mutations = pending.catch(() => undefined);
    return pending;
  }
  encrypt(
    account: NativeProfileAccount,
    credential: NativeCodexCredentials,
  ): EncryptedNativeCredential {
    return encryptCredential(this.#ownedKey(), this.homeId, account, credential);
  }
  decrypt(account: NativeProfileAccount, payload = account.payload): NativeCodexCredentials {
    const key = this.#ownedKey();
    if (!payload) throw new NativeAccountError("recovery-required");
    return decryptCredential(key, this.homeId, account, payload);
  }
  async readCredentials(home = this.home): Promise<NativeCodexCredentials | null> {
    this.assertOwnership();
    const bytes = await (home === this.home ? this.#homeFiles : this.files).read(home, "auth.json");
    if (!bytes) return null;
    try {
      const text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes)) throw new Error("utf8");
      return NativeCodexCredentials.parse(text);
    } catch {
      throw new NativeAccountError("unsupported-storage");
    } finally {
      bytes.fill(0);
    }
  }
  async install(
    target: NativeCodexCredentials | null,
    expected: NativeCodexCredentials | null,
  ): Promise<void> {
    this.assertOwnership();
    const digest = credentialDigest(expected);
    if (target) {
      const bytes = Buffer.from(target.serializeForNativeStore());
      try {
        await this.#homeFiles.replace(this.home, "auth.json", bytes, digest);
      } finally {
        bytes.fill(0);
      }
    } else if (digest) await this.#homeFiles.remove(this.home, "auth.json", digest);
    else if (await this.#homeFiles.read(this.home, "auth.json"))
      throw new NativeAccountError("credential-conflict");
    if (credentialDigest(await this.readCredentials()) !== credentialDigest(target))
      throw new NativeAccountError("credential-conflict");
  }
  async readJournal(): Promise<NativeProfileJournal | null> {
    this.assertOwnership();
    const bytes = await this.files.read(this.directory, "transaction.json");
    return bytes ? parseJournal(bytes, this.homeId) : null;
  }
  async writeJournal(journal: NativeProfileJournal): Promise<void> {
    this.assertOwnership();
    const bytes = serializePrivate(journal);
    parseJournal(bytes, this.homeId);
    const previous = await this.files.read(this.directory, "transaction.json");
    if (previous && parseJournal(previous, this.homeId).operationId !== journal.operationId)
      throw new NativeAccountError("recovery-required");
    await this.files.replace(
      this.directory,
      "transaction.json",
      bytes,
      previous ? nativeDigest(previous) : null,
    );
  }
  async clearJournal(operationId: string): Promise<void> {
    this.assertOwnership();
    const previous = await this.files.read(this.directory, "transaction.json");
    if (!previous) return;
    if (parseJournal(previous, this.homeId).operationId !== operationId)
      throw new NativeAccountError("recovery-required");
    await this.files.remove(this.directory, "transaction.json", nativeDigest(previous));
  }
  stageHome(stage: Pick<NativeLoginStage, "operationId">): string {
    if (!z.string().uuid().safeParse(stage.operationId).success)
      throw new NativeAccountError("recovery-required");
    return path.join(this.directory, "login", stage.operationId);
  }
  async readStage(): Promise<NativeLoginStage | null> {
    this.assertOwnership();
    const bytes = await this.files.read(this.directory, "login.json");
    if (!bytes) return null;
    try {
      const parsed = stageSchema.parse(JSON.parse(bytes.toString("utf8")));
      const { candidate, ...rest } = parsed;
      if (candidate === undefined) return rest;
      const account = parseProfileAccount(candidate);
      if (!account.payload) throw new Error("candidate");
      return { ...rest, candidate: account };
    } catch {
      throw new NativeAccountError("recovery-required");
    }
  }
  async writeStage(stage: NativeLoginStage): Promise<void> {
    this.assertOwnership();
    const previous = await this.files.read(this.directory, "login.json");
    if (
      previous &&
      stageSchema.parse(JSON.parse(previous.toString("utf8"))).operationId !== stage.operationId
    )
      throw new NativeAccountError("recovery-required");
    const bytes = Buffer.from(JSON.stringify(stage));
    if (bytes.length > 5 * 1024 * 1024) throw new NativeAccountError("unsupported-storage");
    await this.files.replace(
      this.directory,
      "login.json",
      bytes,
      previous ? nativeDigest(previous) : null,
    );
  }
  async createStage(
    requestedAccountId?: string,
    operationId: string = randomUUID(),
    options: { activateOnSuccess?: boolean } = {},
  ): Promise<NativeLoginStage> {
    if (await this.readStage()) throw new NativeAccountError("cleanup-required");
    const stage: NativeLoginStage = {
      version: 1,
      operationId,
      sourceAccountId: this.vault.currentAccountId,
      expiresAt: Date.now() + 10 * 60_000,
      ...(requestedAccountId ? { requestedAccountId } : {}),
      ...(options.activateOnSuccess ? { activateOnSuccess: true } : {}),
    };
    // Register before creating anything: a crash cannot leave an untracked secret directory.
    await this.writeStage(stage);
    const home = this.stageHome(stage);
    await this.files.ensureDirectory(path.join(this.directory, "login"));
    await this.files.ensureDirectory(home);
    await this.files.replace(
      home,
      "config.toml",
      Buffer.from('cli_auth_credentials_store = "file"\n[features]\nplugins = false\n'),
      null,
    );
    return stage;
  }
  /** Caller has proved the staging process tree exited. Never follows a stage-root link. */
  async clearStage(stage: NativeLoginStage): Promise<void> {
    this.assertOwnership();
    const recorded = await this.readStage();
    if (!recorded) return;
    if (recorded.operationId !== stage.operationId)
      throw new NativeAccountError("recovery-required");
    const home = this.stageHome(stage);
    const stat = await lstat(home).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new NativeAccountError("cleanup-required");
      const bytes = await this.files.read(home, "auth.json");
      if (bytes) {
        try {
          await this.files.remove(home, "auth.json", nativeDigest(bytes));
        } finally {
          bytes.fill(0);
        }
      }
      await rm(home, { recursive: true });
    }
    const previous = await this.files.read(this.directory, "login.json");
    if (previous) await this.files.remove(this.directory, "login.json", nativeDigest(previous));
  }
  async replaceSaved(
    accountId: string,
    expected: NativeCodexCredentials,
    target: NativeCodexCredentials,
  ): Promise<void> {
    await this.mutate((next) => {
      if (next.currentAccountId === accountId) throw new NativeAccountError("credential-conflict");
      const account = next.accounts.find((a) => a.accountId === accountId);
      if (!account || credentialDigest(this.decrypt(account)) !== credentialDigest(expected))
        throw new NativeAccountError("credential-conflict");
      account.payload = this.encrypt(account, target);
    });
  }
  async close(): Promise<void> {
    const lease = this.#lease;
    this.#lease = undefined;
    this.#key?.fill(0);
    this.#key = undefined;
    if (lease) await lease.release();
  }
}

export function newProfile(
  credential: NativeCodexCredentials,
  accountId: string = randomUUID(),
): NativeProfileAccount {
  return {
    accountId,
    identity: { ...credential.identity },
    label: credential.email ?? `Codex ${accountId.slice(0, 8)}`,
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.planType ? { planType: credential.planType } : {}),
    payload: null,
  };
}
export function matchProfile(
  credential: NativeCodexCredentials | null,
  account: NativeProfileAccount | null,
): void {
  if (
    account === null
      ? credential !== null
      : !credential || !sameCodexCredentialIdentity(credential.identity, account.identity)
  )
    throw new NativeAccountError("credential-conflict");
}
