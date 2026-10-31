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

interface LegacyCompatibilityGuard {
  handle: Awaited<ReturnType<typeof open>>;
  identity: UnixFileIdentity;
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
// The socket Bakery register protects only bind/unlink operations, never Session
// lifetime. A bounded lease recovers a live-PID register after PID reuse or a
// process that stopped making progress inside this short critical section.
// File update locks use no lease: a holder that stalls after reading could still
// rename its stale snapshot over a newer write once it resumes.
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
  leaseMs: number | null,
): boolean {
  // Boot time is derived from the wall clock, so a clock jump looks like a reboot. Without a
  // lease only an owner that is no longer running is safe to reclaim.
  if (leaseMs === null) return !processIsRunning(record.pid);
  if (Math.abs(record.bootTimeSeconds - currentBootTimeSeconds()) > 5) return true;
  if (Math.max(0, Date.now() - mtimeMs) >= leaseMs) return true;
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
  const source = await retryWhileWindowsSharingViolation(() => readFile(filePath, "utf8")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
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

function lockEntryIsAbandoned(snapshot: LockEntrySnapshot, leaseMs: number | null): boolean {
  const ageMs = Math.max(0, Date.now() - snapshot.mtimeMs);
  return snapshot.record
    ? ownerIsAbandoned(snapshot.record, snapshot.mtimeMs, leaseMs)
    : ageMs >= LOCK_MALFORMED_GRACE_MS;
}

async function removeAbandonedLockEntry(
  snapshot: LockEntrySnapshot,
  leaseMs: number | null,
): Promise<boolean> {
  const current = await readLockEntrySnapshot(snapshot.filePath);
  if (
    current === null ||
    current.source !== snapshot.source ||
    !sameUnixFileIdentity(current.identity, snapshot.identity) ||
    !lockEntryIsAbandoned(current, leaseMs)
  ) {
    return false;
  }
  // Each register path contains an unguessable owner token and is never reused,
  // so deleting this exact entry cannot unlink a successor's register.
  await rm(snapshot.filePath, { force: true });
  return true;
}

async function readLockEntryCatalog(
  lockDirectory: string,
  leaseMs: number | null,
): Promise<LockEntryCatalog> {
  const names = await readdir(lockDirectory);
  const entries: LockEntrySnapshot[] = [];
  let unsettled = false;
  for (const name of names) {
    if (!name.startsWith(LOCK_ENTRY_PREFIX) || !name.endsWith(LOCK_ENTRY_SUFFIX)) continue;
    const snapshot = await readLockEntrySnapshot(path.join(lockDirectory, name));
    if (snapshot === null) continue;
    if (lockEntryIsAbandoned(snapshot, leaseMs)) {
      if (!(await removeAbandonedLockEntry(snapshot, leaseMs))) unsettled = true;
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

async function preparePrivateLockDirectory(lockDirectory: string, name: string): Promise<void> {
  await mkdir(lockDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const metadata = await lstat(lockDirectory);
  const ownedByCurrentUser =
    typeof process.getuid !== "function" || metadata.uid === process.getuid();
  if (!metadata.isDirectory() || !ownedByCurrentUser) {
    throw new Error(
      `${name} lock requires a private directory owned by the current user: ${lockDirectory}`,
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
    await retryWhileWindowsSharingViolation(() => rename(temporary, entryPath));
  } finally {
    await rm(temporary, { force: true });
  }
}

const WINDOWS_SHARING_RETRY_COUNT = 100;
const WINDOWS_SHARING_RETRY_DELAY_MS = 10;
const WINDOWS_SHARING_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Windows refuses to replace or open a register while another contender is reading
 * it, reporting EPERM, EACCES or EBUSY until that short read ends. Other platforms
 * never report these for a transient reader, so only Windows retries.
 */
export async function retryWhileWindowsSharingViolation<T>(
  operation: () => Promise<T>,
  platform: NodeJS.Platform = process.platform,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        platform !== "win32" ||
        code === undefined ||
        !WINDOWS_SHARING_ERROR_CODES.has(code) ||
        attempt >= WINDOWS_SHARING_RETRY_COUNT
      ) {
        throw error;
      }
      await delay(WINDOWS_SHARING_RETRY_DELAY_MS);
    }
  }
}

async function removeOwnedLockEntry(entryPath: string, ownerToken: string): Promise<void> {
  const snapshot = await readLockEntrySnapshot(entryPath);
  if (snapshot?.record?.ownerToken !== ownerToken) return;
  await rm(entryPath, { force: true });
}

async function legacyLockState(legacyPath: string): Promise<"absent" | "abandoned" | "blocking"> {
  // Version 1 used one replaceable path, so deleting an abandoned marker could
  // race another version 1 owner. Treat a validated abandoned marker as inert
  // and leave it in place; version 2 ownership lives only in unique registers.
  const metadata = await lstat(legacyPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return "absent";
  if (!metadata.isFile()) return "blocking";
  const source = await readFile(legacyPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return "absent";
  const ageMs = Math.max(0, Date.now() - metadata.mtimeMs);
  const record = parseLegacyLockRecord(source);
  if (record === null) return ageMs < LOCK_MALFORMED_GRACE_MS ? "blocking" : "abandoned";
  return ownerIsAbandoned(record, metadata.mtimeMs, LOCK_MAX_AGE_MS) ? "abandoned" : "blocking";
}

async function tryAcquireLegacyCompatibilityGuard(
  legacyPath: string,
  record: LegacyRemoteSocketLockRecord,
): Promise<LegacyCompatibilityGuard | null> {
  const handle = await open(legacyPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  if (handle === null) return null;
  const metadata = await handle.stat();
  const guard = { handle, identity: { dev: metadata.dev, ino: metadata.ino } };
  try {
    // Publish the schema understood by an already-loaded version 1 shim. A
    // late legacy contender then observes a live owner at the shared path and
    // cannot enter while the version 2 Bakery winner runs the action.
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    return guard;
  } catch (error) {
    await releaseLegacyCompatibilityGuard(legacyPath, guard);
    throw error;
  }
}

async function releaseLegacyCompatibilityGuard(
  legacyPath: string,
  guard: LegacyCompatibilityGuard,
): Promise<void> {
  try {
    await guard.handle.close();
  } finally {
    const metadata = await lstat(legacyPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      metadata?.isFile() &&
      sameUnixFileIdentity({ dev: metadata.dev, ino: metadata.ino }, guard.identity)
    ) {
      await rm(legacyPath, { force: true });
    }
  }
}

function recordHasPriority(left: RemoteSocketLockRecord, right: RemoteSocketLockRecord): boolean {
  return (
    left.ticket < right.ticket ||
    (left.ticket === right.ticket && left.ownerToken < right.ownerToken)
  );
}

interface BakeryLockOptions {
  /** Persistent private directory holding one register per contender. */
  lockDirectory: string;
  /** Version 1 single-path marker still honoured for socket initialization only. */
  legacyPath: string | null;
  /** Age after which a live owner's register is reclaimed; `null` reclaims only dead owners. */
  leaseMs: number | null;
  /** Subject used in errors, e.g. "Remote app-server socket". */
  name: string;
  /** The path the lock protects, used in errors. */
  target: string;
  busyMessage: string;
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
  return withBakeryLock(
    {
      lockDirectory: `${socketPath}.initializers`,
      legacyPath: `${socketPath}.initializing`,
      leaseMs: LOCK_MAX_AGE_MS,
      name: "Remote app-server socket",
      target: socketPath,
      busyMessage: `Remote app-server socket initialization is already in progress at ${socketPath}`,
    },
    action,
  );
}

/**
 * Serializes a short read-modify-write of `file` across processes with the same
 * Bakery registers, kept in the private directory `<file>.lock`. Only registers
 * whose owner process is no longer running are reclaimed, never a live owner's,
 * so a stalled holder cannot rename a stale snapshot over newer data.
 */
export async function withFileUpdateLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  return withBakeryLock(
    {
      lockDirectory: `${file}.lock`,
      legacyPath: null,
      leaseMs: null,
      name: "File update",
      target: file,
      busyMessage: `Another process is still updating ${file}`,
    },
    action,
  );
}

async function withBakeryLock<T>(
  { lockDirectory, legacyPath, leaseMs, name, target, busyMessage }: BakeryLockOptions,
  action: () => Promise<T>,
): Promise<T> {
  await preparePrivateLockDirectory(lockDirectory, name);

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
    const choosingCatalog = await readLockEntryCatalog(lockDirectory, leaseMs);
    const maximumTicket = choosingCatalog.entries.reduce(
      (maximum, entry) => Math.max(maximum, entry.record?.ticket ?? 0),
      0,
    );
    if (maximumTicket >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`${name} lock ticket overflow at ${target}`);
    }
    const ownRecord: RemoteSocketLockRecord = {
      ...baseRecord,
      choosing: false,
      ticket: maximumTicket + 1,
    };
    await writeLockRecordAtomic(lockDirectory, entryPath, ownRecord);

    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
      const catalog = await readLockEntryCatalog(lockDirectory, leaseMs);
      const ownsPublishedEntry = catalog.entries.some(
        (entry) => entry.record?.ownerToken === ownerToken,
      );
      if (!ownsPublishedEntry) {
        throw new Error(`${name} lock ownership was lost at ${target}`);
      }
      const blockedByBakery = catalog.entries.some((entry) => {
        const record = entry.record;
        return (
          record !== null &&
          record.ownerToken !== ownerToken &&
          (record.choosing || recordHasPriority(record, ownRecord))
        );
      });
      if (!catalog.unsettled && !blockedByBakery) {
        if (legacyPath === null) return await action();
        const legacyGuard = await tryAcquireLegacyCompatibilityGuard(legacyPath, {
          version: 1,
          ownerToken,
          pid: baseRecord.pid,
          bootTimeSeconds: baseRecord.bootTimeSeconds,
        });
        if (legacyGuard !== null) {
          try {
            return await action();
          } finally {
            await releaseLegacyCompatibilityGuard(legacyPath, legacyGuard);
          }
        }
        const legacyState = await legacyLockState(legacyPath);
        if (legacyState === "abandoned") {
          // Keep a validated abandoned version 1 marker as a passive fence.
          // Deleting its shared pathname would recreate the version 1
          // reclaimer TOCTOU; an old contender still sees EEXIST, while version
          // 2 ownership remains serialized through unique Bakery registers.
          return await action();
        }
      }
      await delay(LOCK_RETRY_DELAY_MS);
    }
    throw new Error(busyMessage);
  } finally {
    await removeOwnedLockEntry(entryPath, ownerToken);
  }
}
