import { z } from "zod";

import { privateFileDigest, type NativePrivateFileLease } from "../native-private-files.js";
import {
  NativeCodexCredentials,
  sameCodexCredentialIdentity,
  type CodexCredentialIdentity,
} from "./native-codex-credentials.js";

export interface CredentialFileAccess {
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
export interface CredentialAccountRef {
  accountId: string;
  identity: CodexCredentialIdentity;
}

export class CodexCredentialFileError extends Error {
  constructor(readonly code: "unsupported" | "invalid" | "identity-mismatch") {
    super(`Codex credential storage ${code}`);
    this.name = "CodexCredentialFileError";
  }
}

/** Conservative capability rule; undefined storage is not guessed to mean file. */
export function codexCredentialStorageSupport(input: {
  nativeFileInterfaceAvailable: boolean;
  effectiveCredentialStore: unknown;
  environment: NodeJS.ProcessEnv;
}):
  | { supported: true }
  | {
      supported: false;
      reason: "native-storage-unavailable" | "unsupported-storage" | "external-credentials";
    } {
  if (!input.nativeFileInterfaceAvailable)
    return { supported: false, reason: "native-storage-unavailable" };
  if (input.effectiveCredentialStore !== "file")
    return { supported: false, reason: "unsupported-storage" };
  const overrides = new Set([
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_AUTH_TOKEN",
    "CODEX_ACCESS_TOKEN",
  ]);
  if (
    Object.entries(input.environment).some(
      ([key, value]) => overrides.has(key.toUpperCase()) && !!value,
    )
  ) {
    return { supported: false, reason: "external-credentials" };
  }
  return { supported: true };
}

/** Only a stopped official backend may transfer credential ownership to this store. */
export class CodexCredentialFiles {
  readonly #files: CredentialFileAccess;
  readonly #homeFiles: CredentialFileAccess;
  readonly #directory: string;
  readonly #home: string;
  readonly #lockDirectory: string;
  #lease: NativePrivateFileLease | undefined;

  constructor(input: {
    directory: string;
    sharedCodexHome: string;
    files: CredentialFileAccess;
    sharedHomeFiles?: CredentialFileAccess;
    lockDirectory?: string;
  }) {
    this.#files = input.files;
    this.#homeFiles = input.sharedHomeFiles ?? input.files;
    this.#directory = input.directory;
    this.#home = input.sharedCodexHome;
    this.#lockDirectory = input.lockDirectory ?? input.sharedCodexHome;
  }

  async initialize(): Promise<NativePrivateFileLease> {
    if (this.#lease) throw new CodexCredentialFileError("unsupported");
    await this.#homeFiles.ensureDirectory(this.#home);
    await this.#files.ensureDirectory(this.#directory);
    await this.#files.ensureDirectory(this.#lockDirectory);
    // Ownership follows a private directory inside the shared native home.
    const lease = await this.#files.lock(this.#lockDirectory, ".codexhost-writer.lock");
    this.#lease = lease;
    void lease.closed.then(() => {
      if (this.#lease === lease) this.#lease = undefined;
    });
    return {
      closed: lease.closed,
      release: async () => {
        if (this.#lease === lease) this.#lease = undefined;
        await lease.release();
      },
    };
  }

  assertOwnership(): void {
    if (!this.#lease) throw new CodexCredentialFileError("unsupported");
  }

  async readCurrent(): Promise<NativeCodexCredentials | null> {
    this.assertOwnership();
    return this.#decode(await this.#homeFiles.read(this.#home, "auth.json"));
  }

  async load(account: CredentialAccountRef): Promise<NativeCodexCredentials> {
    this.assertOwnership();
    const credentials = this.#decode(
      await this.#files.read(this.#directory, this.#slot(account.accountId)),
    );
    if (!credentials) throw new CodexCredentialFileError("invalid");
    this.#match(credentials, account.identity);
    return credentials;
  }

  async save(account: CredentialAccountRef, credentials: NativeCodexCredentials): Promise<void> {
    this.assertOwnership();
    this.#match(credentials, account.identity);
    const name = this.#slot(account.accountId);
    const previous = await this.#files.read(this.#directory, name);
    const decoded = this.#decode(previous);
    if (decoded) this.#match(decoded, account.identity);
    this.assertOwnership();
    await this.#files.replace(
      this.#directory,
      name,
      Buffer.from(credentials.serializeForNativeStore()),
      previous === null ? null : privateFileDigest(previous),
    );
  }

  async saveCurrent(account: CredentialAccountRef): Promise<NativeCodexCredentials> {
    const current = await this.readCurrent();
    if (!current) throw new CodexCredentialFileError("invalid");
    await this.save(account, current);
    return current;
  }

  /** Commit a rotated inactive credential only if its exact source slot is unchanged. */
  async replaceSaved(
    account: CredentialAccountRef,
    expected: NativeCodexCredentials,
    target: NativeCodexCredentials,
  ): Promise<void> {
    this.assertOwnership();
    this.#match(expected, account.identity);
    this.#match(target, account.identity);
    await this.#files.replace(
      this.#directory,
      this.#slot(account.accountId),
      Buffer.from(target.serializeForNativeStore()),
      privateFileDigest(Buffer.from(expected.serializeForNativeStore())),
    );
  }

  /** Expected native bytes must come from the post-exit observation, not a stale slot. */
  async install(
    target: NativeCodexCredentials | null,
    expected: NativeCodexCredentials | null,
  ): Promise<void> {
    this.assertOwnership();
    const digest =
      expected === null ? null : privateFileDigest(Buffer.from(expected.serializeForNativeStore()));
    if (target !== null) {
      await this.#homeFiles.replace(
        this.#home,
        "auth.json",
        Buffer.from(target.serializeForNativeStore()),
        digest,
      );
    } else if (digest !== null) {
      await this.#homeFiles.remove(this.#home, "auth.json", digest);
    } else if ((await this.#homeFiles.read(this.#home, "auth.json")) !== null) {
      throw new CodexCredentialFileError("identity-mismatch");
    }
  }

  async remove(account: CredentialAccountRef): Promise<void> {
    const current = await this.readCurrent();
    if (current && sameCodexCredentialIdentity(current.identity, account.identity)) {
      throw new CodexCredentialFileError("identity-mismatch");
    }
    const name = this.#slot(account.accountId);
    const bytes = await this.#files.read(this.#directory, name);
    const credentials = this.#decode(bytes);
    if (credentials && bytes) {
      this.#match(credentials, account.identity);
      this.assertOwnership();
      await this.#files.remove(this.#directory, name, privateFileDigest(bytes));
    }
  }

  #slot(accountId: string): string {
    if (!z.string().uuid().safeParse(accountId).success)
      throw new CodexCredentialFileError("invalid");
    return `${accountId}.auth.json`;
  }

  #decode(bytes: Buffer | null): NativeCodexCredentials | null {
    if (bytes === null) return null;
    try {
      const serialized = bytes.toString("utf8");
      if (!Buffer.from(serialized, "utf8").equals(bytes)) throw new Error("Invalid UTF-8");
      return NativeCodexCredentials.parse(serialized);
    } catch {
      throw new CodexCredentialFileError("invalid");
    }
  }

  #match(credentials: NativeCodexCredentials, identity: CodexCredentialIdentity): void {
    if (!sameCodexCredentialIdentity(credentials.identity, identity))
      throw new CodexCredentialFileError("identity-mismatch");
  }
}
