import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface RemoteSocketLockRecord {
  version: 2;
  ownerToken: string;
  pid: number;
  bootTimeSeconds: number;
  choosing: boolean;
  ticket: number;
}

interface LegacyRemoteSocketLockRecord {
  version: 1;
  ownerToken: string;
  pid: number;
  bootTimeSeconds: number;
}

interface UnixFileIdentity {
  dev: number;
  ino: number;
}

interface LockEntrySnapshot {
  filePath: string;
  source: string;
  identity: UnixFileIdentity;
  mtimeMs: number;
  record: RemoteSocketLockRecord | null;
}

interface LockEntryCatalog {
  entries: LockEntrySnapshot[];
  unsettled: boolean;
}

const LOCK_RETRY_COUNT = 200;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MALFORMED_GRACE_MS = 1_000;
// The Bakery register protects only bind/unlink operations, never Session
// lifetime. A bounded lease recovers a live-PID register after PID reuse or a
// process that stopped making progress inside this short critical section.
const LOCK_MAX_AGE_MS = 30_000;
const LOCK_ENTRY_PREFIX = "owner-";
const LOCK_ENTRY_SUFFIX = ".json";

function currentBootTimeSeconds(): number {
  return Math.round(Date.now() / 1_000 - uptime());
}

function validOwnerFields(record: Record<string, unknown>): boolean {
  return (
    typeof record.ownerToken === "string" &&
    record.ownerToken.length > 0 &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.bootTimeSeconds === "number" &&
    Number.isSafeInteger(record.bootTimeSeconds)
  );
}

function parseLockRecord(source: string): RemoteSocketLockRecord | null {
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 2 ||
      !validOwnerFields(record) ||
      typeof record.choosing !== "boolean" ||
      typeof record.ticket !== "number" ||
      !Number.isSafeInteger(record.ticket) ||
      record.ticket < 0 ||
      (record.choosing ? record.ticket !== 0 : record.ticket === 0)
    ) {
      return null;
    }
    return record as unknown as RemoteSocketLockRecord;
  } catch {
    return null;
  }
}

function parseLegacyLockRecord(source: string): LegacyRemoteSocketLockRecord | null {
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !validOwnerFields(record)) return null;
    return record as unknown as LegacyRemoteSocketLockRecord;
  } catch {
    return null;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function ownerIsAbandoned(
  record: Pick<RemoteSocketLockRecord, "pid" | "bootTimeSeconds">,
  mtimeMs: number,
): boolean {
  if (Math.abs(record.bootTimeSeconds - currentBootTimeSeconds()) > 5) return true;
  if (Math.max(0, Date.now() - mtimeMs) >= LOCK_MAX_AGE_MS) return true;
  return !processIsRunning(record.pid);
}

function sameUnixFileIdentity(left: UnixFileIdentity, right: UnixFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function lockEntryName(ownerToken: string): string {
  return `${LOCK_ENTRY_PREFIX}${ownerToken}${LOCK_ENTRY_SUFFIX}`;
}

async function readLockEntrySnapshot(filePath: string): Promise<LockEntrySnapshot | null> {
  const metadata = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null || !metadata.isFile()) return null;
  const source = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return null;
  const record = parseLockRecord(source);
  return {
    filePath,
    source,
    identity: { dev: metadata.dev, ino: metadata.ino },
    mtimeMs: metadata.mtimeMs,
    record: record && path.basename(filePath) === lockEntryName(record.ownerToken) ? record : null,
  };
}

function lockEntryIsAbandoned(snapshot: LockEntrySnapshot): boolean {
  const ageMs = Math.max(0, Date.now() - snapshot.mtimeMs);
  return snapshot.record
    ? ownerIsAbandoned(snapshot.record, snapshot.mtimeMs)
    : ageMs >= LOCK_MALFORMED_GRACE_MS;
}

async function removeAbandonedLockEntry(snapshot: LockEntrySnapshot): Promise<boolean> {
  const current = await readLockEntrySnapshot(snapshot.filePath);
  if (
    current === null ||
    current.source !== snapshot.source ||
    !sameUnixFileIdentity(current.identity, snapshot.identity) ||
    !lockEntryIsAbandoned(current)
  ) {
    return false;
  }
  // Each register path contains an unguessable owner token and is never reused,
  // so deleting this exact entry cannot unlink a successor's register.
  await rm(snapshot.filePath, { force: true });
  return true;
}

async function readLockEntryCatalog(lockDirectory: string): Promise<LockEntryCatalog> {
  const names = await readdir(lockDirectory);
  const entries: LockEntrySnapshot[] = [];
  let unsettled = false;
  for (const name of names) {
    if (!name.startsWith(LOCK_ENTRY_PREFIX) || !name.endsWith(LOCK_ENTRY_SUFFIX)) continue;
    const snapshot = await readLockEntrySnapshot(path.join(lockDirectory, name));
    if (snapshot === null) continue;
    if (lockEntryIsAbandoned(snapshot)) {
      if (!(await removeAbandonedLockEntry(snapshot))) unsettled = true;
      continue;
    }
    if (snapshot.record === null) {
      unsettled = true;
      continue;
    }
    entries.push(snapshot);
  }
  return { entries, unsettled };
}

async function preparePrivateLockDirectory(lockDirectory: string): Promise<void> {
  await mkdir(lockDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const metadata = await lstat(lockDirectory);
  const ownedByCurrentUser =
    typeof process.getuid !== "function" || metadata.uid === process.getuid();
  if (!metadata.isDirectory() || !ownedByCurrentUser) {
    throw new Error(
      `Remote app-server socket lock requires a private directory owned by the current user: ${lockDirectory}`,
    );
  }
  await chmod(lockDirectory, 0o700);
}

async function writeLockRecordAtomic(
  lockDirectory: string,
  entryPath: string,
  record: RemoteSocketLockRecord,
): Promise<void> {
  const temporary = path.join(lockDirectory, `.tmp-${record.ownerToken}-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, entryPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeOwnedLockEntry(entryPath: string, ownerToken: string): Promise<void> {
  const snapshot = await readLockEntrySnapshot(entryPath);
  if (snapshot?.record?.ownerToken !== ownerToken) return;
  await rm(entryPath, { force: true });
}

async function legacyLockBlocks(legacyPath: string): Promise<boolean> {
  // Version 1 used one replaceable path, so deleting an abandoned marker could
  // race another version 1 owner. Treat a validated abandoned marker as inert
  // and leave it in place; version 2 ownership lives only in unique registers.
  const metadata = await lstat(legacyPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return false;
  if (!metadata.isFile()) return true;
  const source = await readFile(legacyPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return false;
  const ageMs = Math.max(0, Date.now() - metadata.mtimeMs);
  const record = parseLegacyLockRecord(source);
  if (record === null) return ageMs < LOCK_MALFORMED_GRACE_MS;
  return !ownerIsAbandoned(record, metadata.mtimeMs);
}

function recordHasPriority(left: RemoteSocketLockRecord, right: RemoteSocketLockRecord): boolean {
  return (
    left.ticket < right.ticket ||
    (left.ticket === right.ticket && left.ownerToken < right.ownerToken)
  );
}

/**
 * Serializes Unix control-socket bind and unlink operations.
 *
 * Each contender owns a unique register in a persistent private directory and
 * uses Lamport's Bakery ordering. Abandoned registers are reclaimed by their
 * unique paths; no process ever unlinks a shared owner path, so concurrent
 * recovery cannot remove a successor's lock.
 */
export async function withRemoteAppServerSocketInitializationLock<T>(
  socketPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const legacyPath = `${socketPath}.initializing`;
  const lockDirectory = `${socketPath}.initializers`;
  await preparePrivateLockDirectory(lockDirectory);

  const ownerToken = randomUUID();
  const entryPath = path.join(lockDirectory, lockEntryName(ownerToken));
  const baseRecord = {
    version: 2,
    ownerToken,
    pid: process.pid,
    bootTimeSeconds: currentBootTimeSeconds(),
  } as const;
  await writeLockRecordAtomic(lockDirectory, entryPath, {
    ...baseRecord,
    choosing: true,
    ticket: 0,
  });

  try {
    const choosingCatalog = await readLockEntryCatalog(lockDirectory);
    const maximumTicket = choosingCatalog.entries.reduce(
      (maximum, entry) => Math.max(maximum, entry.record?.ticket ?? 0),
      0,
    );
    if (maximumTicket >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`Remote app-server socket lock ticket overflow at ${socketPath}`);
    }
    const ownRecord: RemoteSocketLockRecord = {
      ...baseRecord,
      choosing: false,
      ticket: maximumTicket + 1,
    };
    await writeLockRecordAtomic(lockDirectory, entryPath, ownRecord);

    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
      const catalog = await readLockEntryCatalog(lockDirectory);
      const ownsPublishedEntry = catalog.entries.some(
        (entry) => entry.record?.ownerToken === ownerToken,
      );
      if (!ownsPublishedEntry) {
        throw new Error(`Remote app-server socket lock ownership was lost at ${socketPath}`);
      }
      const blockedByBakery = catalog.entries.some((entry) => {
        const record = entry.record;
        return (
          record !== null &&
          record.ownerToken !== ownerToken &&
          (record.choosing || recordHasPriority(record, ownRecord))
        );
      });
      if (!catalog.unsettled && !blockedByBakery && !(await legacyLockBlocks(legacyPath))) {
        return await action();
      }
      await delay(LOCK_RETRY_DELAY_MS);
    }
    throw new Error(
      `Remote app-server socket initialization is already in progress at ${socketPath}`,
    );
  } finally {
    await removeOwnedLockEntry(entryPath, ownerToken);
  }
}
