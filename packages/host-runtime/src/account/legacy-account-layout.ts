import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { privateFileDigest } from "../native-private-files.js";
import type { CodexCredentialFiles, CredentialFileAccess } from "./codex-credential-files.js";
import { NativeCodexCredentials } from "./native-codex-credentials.js";
import type { SavedCodexAccounts } from "./saved-codex-accounts.js";

const legacyAccountSchema = z
  .object({
    accountId: z.string().min(1).max(256),
    codexHome: z.string().min(1),
    email: z.string().email().optional(),
    planType: z.string().optional(),
    label: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
const legacyRegistrySchema = z
  .object({
    formatVersion: z.literal(1),
    activeAccountId: z.string().min(1).max(256),
    accounts: z.array(legacyAccountSchema).min(1).max(128),
  })
  .strict();

type LegacyAccount = z.infer<typeof legacyAccountSchema>;
export type LegacyAccountLayoutBlocker =
  | "invalid-registry"
  | "missing-home"
  | "duplicate-home"
  | "shared-home-not-legacy"
  | "configuration-difference"
  | "secondary-native-data";

export type LegacyAccountLayoutInventory =
  | { kind: "none"; registryFile: string }
  | {
      kind: "legacy";
      registryFile: string;
      registryDigest: string;
      activeAccountId: string;
      accountCount: number;
      sharedAccountId: string | null;
      credentialOnlyAccountIds: string[];
      rolloutAccountIds: string[];
      blockers: LegacyAccountLayoutBlocker[];
      accounts: LegacyAccount[];
    };

// Generated caches/bootstrap databases are not account-owned history. Source homes
// remain untouched, so excluding them from the shared home is non-destructive.
const ignoredSecondaryEntries = new Set([
  "auth.json",
  "config.toml",
  "log",
  "logs",
  ".tmp",
  "tmp",
  "cache",
  "plugins",
  "skills",
  "version.json",
  "installation_id",
  "models_cache.json",
  "logs_2.sqlite",
  "logs_2.sqlite-shm",
  "logs_2.sqlite-wal",
  "goals_1.sqlite",
  "goals_1.sqlite-shm",
  "goals_1.sqlite-wal",
  "queue_1.sqlite",
  "queue_1.sqlite-shm",
  "queue_1.sqlite-wal",
  "memories_1.sqlite",
  "memories_1.sqlite-shm",
  "memories_1.sqlite-wal",
  "state_5.sqlite",
  "state_5.sqlite-shm",
  "state_5.sqlite-wal",
  "mcp-oauth-locks",
  "thread-writer-locks",
  "thread_history_1.sqlite",
  "thread_history_1.sqlite-shm",
  "thread_history_1.sqlite-wal",
]);

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
async function configuration(directory: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(directory, "config.toml"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function nonemptyDirectory(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length > 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function databaseHasRows(file: string, tables: readonly string[]): boolean {
  if (!existsSync(file)) return false;
  try {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      return tables.some((table) => {
        const exists = database
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
          .get(table);
        return (
          exists !== undefined &&
          Number(database.prepare(`SELECT count(*) AS count FROM "${table}"`).get()?.count ?? 0) > 0
        );
      });
    } finally {
      database.close();
    }
  } catch {
    return true;
  }
}

async function hasUnsupportedNativeData(home: string): Promise<boolean> {
  if (
    (await nonemptyDirectory(path.join(home, "attachments"))) ||
    (await nonemptyDirectory(path.join(home, "memories"))) ||
    databaseHasRows(path.join(home, "goals_1.sqlite"), [
      "thread_goals",
      "thread_goal_continuation_deferrals",
    ]) ||
    databaseHasRows(path.join(home, "queue_1.sqlite"), [
      "queued_items",
      "queued_thread_revisions",
    ]) ||
    databaseHasRows(path.join(home, "memories_1.sqlite"), ["stage1_outputs", "jobs"]) ||
    databaseHasRows(path.join(home, "state_5.sqlite"), [
      "thread_dynamic_tools",
      "thread_spawn_edges",
      "remote_control_enrollments",
      "external_agent_config_imports",
      "projects",
      "project_roots",
      "project_idempotency_keys",
      "thread_artifacts",
    ])
  )
    return true;
  try {
    return (await lstat(path.join(home, "history.jsonl"))).size > 0;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
}
function invalidInventory(registryFile: string, serialized = ""): LegacyAccountLayoutInventory {
  return {
    kind: "legacy",
    registryFile,
    registryDigest: createHash("sha256").update(serialized).digest("hex"),
    activeAccountId: "",
    accountCount: 0,
    sharedAccountId: null,
    credentialOnlyAccountIds: [],
    rolloutAccountIds: [],
    blockers: ["invalid-registry"],
    accounts: [],
  };
}

/** Reads v1 metadata, directory names and configuration bytes. It never reads auth.json. */
export async function inspectLegacyAccountLayout(
  dataDirectory: string,
  sharedCodexHome: string,
): Promise<LegacyAccountLayoutInventory> {
  const registryFile = path.join(path.resolve(dataDirectory), "codex-accounts", "accounts.json");
  let serialized: string;
  try {
    serialized = await readFile(registryFile, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "none", registryFile };
    return invalidInventory(registryFile);
  }
  let parsed: z.infer<typeof legacyRegistrySchema>;
  try {
    parsed = legacyRegistrySchema.parse(JSON.parse(serialized));
  } catch {
    return invalidInventory(registryFile, serialized);
  }
  const blockers = new Set<LegacyAccountLayoutBlocker>();
  if (!parsed.accounts.some((account) => account.accountId === parsed.activeAccountId))
    blockers.add("invalid-registry");
  const homes = new Set<string>();
  let sharedAccountId: string | null = null;
  const shared = path.resolve(sharedCodexHome);
  for (const account of parsed.accounts) {
    if (!path.isAbsolute(account.codexHome)) {
      blockers.add("invalid-registry");
      continue;
    }
    const home = path.resolve(account.codexHome);
    const key = process.platform === "win32" ? home.toLowerCase() : home;
    if (homes.has(key)) blockers.add("duplicate-home");
    homes.add(key);
    if (path.relative(home, shared) === "") sharedAccountId = account.accountId;
    if (!(await directoryExists(home))) blockers.add("missing-home");
  }
  if (!sharedAccountId) blockers.add("shared-home-not-legacy");

  const credentialOnlyAccountIds: string[] = [];
  const rolloutAccountIds: string[] = [];
  if (sharedAccountId && !blockers.has("missing-home")) {
    const sharedConfig = await configuration(shared);
    for (const account of parsed.accounts) {
      if (account.accountId === sharedAccountId) continue;
      const home = path.resolve(account.codexHome);
      const otherConfig = await configuration(home);
      if (otherConfig !== null && (sharedConfig === null || !otherConfig.equals(sharedConfig)))
        blockers.add("configuration-difference");
      const entries = await readdir(home);
      const hasRollouts =
        (await nonemptyDirectory(path.join(home, "sessions"))) ||
        (await nonemptyDirectory(path.join(home, "archived_sessions")));
      const nativeData = entries.filter(
        (entry) =>
          !ignoredSecondaryEntries.has(entry) &&
          entry !== "sessions" &&
          entry !== "archived_sessions",
      );
      if (nativeData.length > 0 || (await hasUnsupportedNativeData(home)))
        blockers.add("secondary-native-data");
      else if (hasRollouts) rolloutAccountIds.push(account.accountId);
      else credentialOnlyAccountIds.push(account.accountId);
    }
  }
  return {
    kind: "legacy",
    registryFile,
    registryDigest: createHash("sha256").update(serialized).digest("hex"),
    activeAccountId: parsed.activeAccountId,
    accountCount: parsed.accounts.length,
    sharedAccountId,
    credentialOnlyAccountIds,
    rolloutAccountIds,
    blockers: [...blockers],
    accounts: parsed.accounts,
  };
}

export function canAdoptLegacyLayout(inventory: LegacyAccountLayoutInventory): boolean {
  if (inventory.kind === "none" || inventory.blockers.length > 0) return false;
  if (!inventory.sharedAccountId) return false;
  if (inventory.accountCount === 1) return inventory.sharedAccountId === inventory.activeAccountId;
  return (
    inventory.credentialOnlyAccountIds.length + inventory.rolloutAccountIds.length ===
    inventory.accountCount - 1
  );
}

type RolloutCopy = { source: string; target: string; bytes: number };

async function collectRolloutCopies(
  sourceHome: string,
  sharedHome: string,
): Promise<RolloutCopy[]> {
  const copies: RolloutCopy[] = [];
  const walk = async (rootName: "sessions" | "archived_sessions", relative = ""): Promise<void> => {
    const sourceDirectory = path.join(sourceHome, rootName, relative);
    let entries;
    try {
      entries = await readdir(sourceDirectory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("Legacy rollout migration rejects links");
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(rootName, child);
      else if (entry.isFile()) {
        const source = path.join(sourceHome, rootName, child);
        const stat = await lstat(source);
        if (stat.size > 512 * 1024 * 1024) throw new Error("Legacy rollout file is too large");
        copies.push({ source, target: path.join(sharedHome, rootName, child), bytes: stat.size });
        if (copies.length > 100_000) throw new Error("Legacy rollout inventory is too large");
      } else throw new Error("Legacy rollout migration found an unsupported entry");
    }
  };
  await walk("sessions");
  await walk("archived_sessions");
  return copies;
}

async function mergeLegacyRollouts(
  inventory: Extract<LegacyAccountLayoutInventory, { kind: "legacy" }>,
): Promise<number> {
  const shared = inventory.accounts.find(
    (account) => account.accountId === inventory.sharedAccountId,
  );
  if (!shared) throw new Error("Legacy shared home is unavailable");
  const plan: RolloutCopy[] = [];
  for (const account of inventory.accounts) {
    if (!inventory.rolloutAccountIds.includes(account.accountId)) continue;
    plan.push(
      ...(await collectRolloutCopies(
        path.resolve(account.codexHome),
        path.resolve(shared.codexHome),
      )),
    );
  }
  let total = 0;
  const pending: RolloutCopy[] = [];
  for (const copy of plan) {
    total += copy.bytes;
    if (total > 10 * 1024 * 1024 * 1024) throw new Error("Legacy rollout migration is too large");
    try {
      const [source, target] = await Promise.all([readFile(copy.source), readFile(copy.target)]);
      if (!source.equals(target)) throw new Error("Legacy rollout collision");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") pending.push(copy);
      else throw error;
    }
  }
  for (const copy of pending) {
    const directory = path.dirname(copy.target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const source = await readFile(copy.source);
    const temporary = path.join(directory, `.codexhost-migration-${randomUUID()}.tmp`);
    const target = await open(temporary, "wx", 0o600);
    try {
      await target.writeFile(source);
      await target.sync();
    } finally {
      await target.close();
    }
    try {
      // Link publishes a complete inode and fails rather than overwriting a racing writer.
      await link(temporary, copy.target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return plan.length;
}

/** Imports supported rollout-only or credential-only secondary homes. Originals remain the consistency backup. */
export async function adoptLegacyAccountLayout(input: {
  inventory: LegacyAccountLayoutInventory;
  files: CredentialFileAccess;
  sourceCredentialFiles?: CredentialFileAccess;
  migrationDirectory: string;
  accounts: SavedCodexAccounts;
  credentials: CodexCredentialFiles;
  oldOfficialBackendsExited: boolean;
}): Promise<void> {
  const inventory = input.inventory;
  if (inventory.kind !== "legacy" || !canAdoptLegacyLayout(inventory))
    throw new Error("Legacy Codex Account layout migration is blocked");
  if (inventory.accountCount > 1 && !input.oldOfficialBackendsExited)
    throw new Error("Legacy official process-tree exit is unconfirmed");
  const recordName = "legacy-migration.json";
  const previous = await input.files.read(input.migrationDirectory, recordName);
  let alreadyCommitted = false;
  if (previous !== null) {
    try {
      const record = JSON.parse(previous.toString("utf8")) as unknown;
      if (
        typeof record !== "object" ||
        record === null ||
        !("registryDigest" in record) ||
        record.registryDigest !== inventory.registryDigest
      )
        throw new Error("conflict");
      alreadyCommitted = "stage" in record && record.stage === "committed";
    } catch {
      throw new Error("Legacy migration record conflicts with the v1 registry");
    }
  }
  if (alreadyCommitted) {
    await input.accounts.initialize();
    return;
  }
  const prepared = Buffer.from(
    JSON.stringify({
      version: 1,
      sourceVersion: 1,
      registryDigest: inventory.registryDigest,
      accountCount: inventory.accountCount,
      stage: "prepared",
    }),
  );
  if (previous === null)
    await input.files.replace(input.migrationDirectory, recordName, prepared, null);
  const migratedRolloutCount = await mergeLegacyRollouts(inventory);
  await input.accounts.initialize();
  const imported = new Map<string, string>();
  const nativeByLegacy = new Map<string, NativeCodexCredentials>();
  for (const legacy of inventory.accounts) {
    const bytes = await (input.sourceCredentialFiles ?? input.files).read(
      path.resolve(legacy.codexHome),
      "auth.json",
    );
    if (bytes === null) continue;
    let native: NativeCodexCredentials;
    try {
      native = NativeCodexCredentials.parse(bytes.toString("utf8"));
    } catch {
      // Missing/invalid credentials require re-login; never fabricate a connected Account.
      continue;
    }
    const account = await input.accounts.saveVerifiedAccount({
      identity: native.identity,
      label: legacy.label,
      ...(native.email ? { email: native.email } : {}),
      ...(native.planType ? { planType: native.planType } : {}),
    });
    await input.credentials.save(account, native);
    imported.set(legacy.accountId, account.accountId);
    nativeByLegacy.set(legacy.accountId, native);
  }
  const currentAccountId = imported.get(inventory.activeAccountId) ?? null;
  const actual = await input.credentials.readCurrent();
  if (actual) {
    const backupName = "legacy-shared-auth.backup";
    const backup = await input.files.read(input.migrationDirectory, backupName);
    if (backup === null)
      await input.files.replace(
        input.migrationDirectory,
        backupName,
        Buffer.from(actual.serializeForNativeStore()),
        null,
      );
  }
  if (inventory.activeAccountId !== inventory.sharedAccountId) {
    const sharedNative = nativeByLegacy.get(inventory.sharedAccountId ?? "") ?? null;
    if (actual?.serializeForNativeStore() !== sharedNative?.serializeForNativeStore())
      throw new Error("Legacy shared credential changed during migration");
    await input.credentials.install(nativeByLegacy.get(inventory.activeAccountId) ?? null, actual);
  }
  await input.accounts.setCurrentAccountId(currentAccountId);
  const committed = Buffer.from(
    JSON.stringify({
      version: 1,
      sourceVersion: 1,
      registryDigest: inventory.registryDigest,
      accountCount: inventory.accountCount,
      importedAccountCount: imported.size,
      migratedRolloutCount,
      stage: "committed",
    }),
  );
  const observed = await input.files.read(input.migrationDirectory, recordName);
  if (observed === null) throw new Error("Legacy migration record is unavailable");
  await input.files.replace(
    input.migrationDirectory,
    recordName,
    committed,
    privateFileDigest(observed),
  );
}

export async function blockingLegacyAccountRegistry(
  dataDirectory: string,
  sharedCodexHome: string,
): Promise<string | undefined> {
  const inventory = await inspectLegacyAccountLayout(dataDirectory, sharedCodexHome);
  return inventory.kind === "none" || canAdoptLegacyLayout(inventory)
    ? undefined
    : inventory.registryFile;
}
