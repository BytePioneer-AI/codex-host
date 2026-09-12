import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nativeDigest } from "./native-profile-vault.js";

const accountSchema = z
  .object({
    accountId: z.string().min(1).max(256),
    codexHome: z.string().min(1).max(16_384),
    label: z.string().min(1).max(256),
    email: z.string().email().optional(),
    planType: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
const registrySchema = z
  .object({
    formatVersion: z.literal(1),
    activeAccountId: z.string(),
    accounts: z.array(accountSchema).min(1).max(128),
  })
  .strict();
const bindingsSchema = z
  .object({ formatVersion: z.literal(1), bindings: z.record(z.string(), z.string()) })
  .strict();
export interface LegacyHomeInventory {
  accountId: string;
  home: string;
  /** Every top-level entry is included, not a rollout-only allowlist. No credential contents. */
  entries: string[];
}
export type NativeAccountLayout =
  | { kind: "new" }
  | { kind: "in-place"; registryDigest: string; accountId: string; label: string }
  | {
      kind: "migration-required";
      reason: "invalid-metadata" | "multiple-homes" | "foreign-home";
      homes: LegacyHomeInventory[];
      /** A clean legacy installation may keep using its already-selected permanent home.
       * This does not adopt the other homes or enable managed Account operations. */
      nativeCompatibility?: { accountId: string; registryDigest: string };
      /** Eligibility for credential-only adoption; current-home managed state must
       * still pass the normal Vault/Journal recovery path. Other homes stay read-only. */
      credentialImport?: { accountId: string; registryDigest: string };
    };

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export async function canonicalCodexHome(home: string): Promise<string> {
  const absolute = path.resolve(home);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalCodexHome(parent), path.basename(absolute));
  }
}
/** Bounded, non-following metadata read. Missing is different from unreadable or malformed. */
async function metadata(file: string): Promise<Buffer | null> {
  const named = await lstat(file).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!named) return null;
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) throw new Error("metadata");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 4 * 1024 * 1024 ||
      before.dev !== named.dev ||
      before.ino !== named.ino
    )
      throw new Error("metadata");
    const buffer = Buffer.alloc(before.size + 1);
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(file);
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.nlink !== 1 ||
      current.nlink !== 1 ||
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw new Error("changed");
    return buffer.subarray(0, position);
  } finally {
    await handle.close();
  }
}

/** The supported in-place layout loses no native data because nothing is moved.
 * Multiple homes still require migration. A clean layout whose selected Account
 * already uses the permanent home may retain native startup without Account management.
 */
export async function inspectNativeAccountLayout(
  dataDirectory: string,
  home: string,
): Promise<NativeAccountLayout> {
  const directory = path.join(path.resolve(dataDirectory), "codex-accounts");
  const homes: LegacyHomeInventory[] = [];
  try {
    const stat = await lstat(directory).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("directory");
    const registry = await metadata(path.join(directory, "accounts.json"));
    const bindingBytes = await metadata(path.join(directory, "thread-accounts.json"));
    const bindings = bindingBytes
      ? bindingsSchema.parse(JSON.parse(bindingBytes.toString("utf8"))).bindings
      : {};
    if (!registry) {
      if (Object.keys(bindings).length) throw new Error("orphan bindings");
      return { kind: "new" };
    }
    const parsed = registrySchema.parse(JSON.parse(registry.toString("utf8")));
    const ids = new Set(parsed.accounts.map((account) => account.accountId));
    if (
      ids.size !== parsed.accounts.length ||
      !ids.has(parsed.activeAccountId) ||
      Object.entries(bindings).some(([threadId, accountId]) => !threadId || !ids.has(accountId))
    )
      throw new Error("identity");
    const canonical = await canonicalCodexHome(home);
    let entryCount = 0;
    let entryBytes = 0;
    for (const account of parsed.accounts) {
      if (!path.isAbsolute(account.codexHome)) throw new Error("home");
      const stat = await lstat(account.codexHome);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("home");
      const accountHome = await canonicalCodexHome(account.codexHome);
      const entries: string[] = [];
      for await (const entry of await opendir(accountHome)) {
        entryCount++;
        entryBytes += Buffer.byteLength(entry.name);
        if (entryCount > 100_000 || entryBytes > 4 * 1024 * 1024) throw new Error("inventory");
        entries.push(entry.name);
      }
      homes.push({ accountId: account.accountId, home: accountHome, entries: entries.sort() });
    }
    const key = (value: string): string =>
      process.platform === "win32" ? value.toLowerCase() : value;
    if (new Set(homes.map((entry) => key(entry.home))).size !== homes.length)
      throw new Error("duplicate home");
    if (homes.length > 1) {
      const selected = homes.find((entry) => entry.accountId === parsed.activeAccountId);
      const clean = homes.every((entry) =>
        entry.entries.every(
          (name) =>
            ![".codexhost-native-accounts", ".codexhost-process.json"].includes(name.toLowerCase()),
        ),
      );
      return {
        kind: "migration-required",
        reason: "multiple-homes",
        homes,
        ...(selected &&
        key(selected.home) === key(canonical) &&
        homes.every((entry) =>
          entry.entries.every(
            (name) =>
              name.toLowerCase() !== ".codexhost-process.json" &&
              (key(entry.home) === key(canonical) ||
                name.toLowerCase() !== ".codexhost-native-accounts"),
          ),
        )
          ? {
              credentialImport: {
                accountId: selected.accountId,
                registryDigest: nativeDigest(registry),
              },
            }
          : {}),
        ...(clean && selected && key(selected.home) === key(canonical)
          ? {
              nativeCompatibility: {
                accountId: selected.accountId,
                registryDigest: nativeDigest(registry),
              },
            }
          : {}),
      };
    }
    const only = homes[0],
      account = parsed.accounts[0];
    if (!only || !account || key(only.home) !== key(canonical))
      return { kind: "migration-required", reason: "foreign-home", homes };
    return {
      kind: "in-place",
      registryDigest: nativeDigest(registry),
      accountId: account.accountId,
      label: account.label,
    };
  } catch {
    return { kind: "migration-required", reason: "invalid-metadata", homes };
  }
}
