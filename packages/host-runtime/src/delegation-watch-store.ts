import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ThreadWatchEntry, ThreadWatchOutcome } from "./delegation-types.js";

/** A watch as kept on disk. Holds identifiers, deadlines and reasons only, never Thread content. */
export interface PersistedWatch extends ThreadWatchEntry {
  id: string;
  timeoutMs: number;
  /** Epoch milliseconds; downtime counts against it. */
  deadline: number;
  deliveryDeadline?: number;
  /** A send was started and its outcome was not recorded; deliver again after a restart. */
  delivering?: boolean;
  /** Why an `interrupted` outcome was decided after a restart, for the notification. */
  restartNote?: string;
  /** Recorded when the watched Thread stops, for client events. */
  harnessId?: string;
  refs?: string[];
}

export interface DelegationWatchStore {
  /** Takes over the records of Runtimes that have exited and returns them. */
  adopt(): Promise<PersistedWatch[]>;
  save(watch: PersistedWatch): Promise<void>;
  remove(id: string): Promise<void>;
}

interface Owner {
  pid: number;
  /** Boot time in seconds, so a pid reused after a reboot is not mistaken for the owner. */
  boot: number;
}

interface WatchFile {
  formatVersion: 1;
  owner: Owner;
  watch: PersistedWatch;
}

const RECORD_SUFFIX = ".json";
const CLAIM_MARKER = ".claim-";
const BOOT_TOLERANCE_SECONDS = 5;
const WATCH_ID = /^[A-Za-z0-9-]{1,64}$/u;
const STATES = new Set(["watching", "pendingDelivery", "undeliverable"]);
const OUTCOMES = new Set<ThreadWatchOutcome>([
  "completed",
  "failed",
  "interrupted",
  "timedOut",
  "unreadable",
  "notFound",
]);

export function defaultDelegationWatchDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, "delegation-watches");
}

function currentOwner(): Owner {
  return { pid: process.pid, boot: Math.round(Date.now() / 1_000 - os.uptime()) };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerAlive(owner: Owner, self: Owner): boolean {
  if (Math.abs(owner.boot - self.boot) > BOOT_TOLERANCE_SECONDS) return false;
  return owner.pid === self.pid || processAlive(owner.pid);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || Number.isFinite(value);
}

function parseWatchFile(text: string): WatchFile {
  const value = JSON.parse(text) as Partial<WatchFile> | null;
  const owner = value?.owner;
  const watch = value?.watch as Partial<PersistedWatch> | undefined;
  if (
    value?.formatVersion !== 1 ||
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    !Number.isFinite(owner.boot) ||
    !watch ||
    typeof watch.id !== "string" ||
    !WATCH_ID.test(watch.id) ||
    typeof watch.threadId !== "string" ||
    typeof watch.notifyThreadId !== "string" ||
    typeof watch.registeredAt !== "string" ||
    !STATES.has(watch.state as string) ||
    (watch.outcome !== undefined && !OUTCOMES.has(watch.outcome)) ||
    !optionalString(watch.turnId) ||
    !optionalString(watch.reason) ||
    !Number.isSafeInteger(watch.timeoutMs) ||
    !Number.isFinite(watch.deadline) ||
    !optionalNumber(watch.deliveryDeadline) ||
    (watch.delivering !== undefined && typeof watch.delivering !== "boolean") ||
    !optionalString(watch.restartNote) ||
    !optionalString(watch.harnessId) ||
    (watch.refs !== undefined &&
      (!Array.isArray(watch.refs) || watch.refs.some((ref) => typeof ref !== "string")))
  ) {
    throw new Error("unrecognized watch record");
  }
  return value as WatchFile;
}

/**
 * One file per watch, owned by the Runtime process that wrote it. Several
 * Runtimes may share the data directory; each writes only its own records, and
 * a starting Runtime adopts records whose owner has exited. Adoption claims a
 * record with an atomic rename, so only one Runtime takes it over.
 */
export class FileDelegationWatchStore implements DelegationWatchStore {
  readonly #directory: string;
  readonly #diagnose: (error: unknown) => void;
  readonly #owner = currentOwner();

  constructor(directory: string, diagnose: (error: unknown) => void = () => undefined) {
    this.#directory = directory;
    this.#diagnose = diagnose;
  }

  async adopt(): Promise<PersistedWatch[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const adopted: PersistedWatch[] = [];
    for (const name of names) {
      const claimAt = name.indexOf(CLAIM_MARKER);
      const isRecord = claimAt < 0 && name.endsWith(RECORD_SUFFIX);
      // A claim left by an adopter that exited before finishing is adopted again.
      const claimer = claimAt >= 0 ? Number(name.slice(claimAt + CLAIM_MARKER.length)) : NaN;
      if (!isRecord && !(Number.isSafeInteger(claimer) && !processAlive(claimer))) continue;
      const watch = await this.#adoptFile(name).catch((error: unknown) => {
        this.#diagnose(error);
        return undefined;
      });
      if (watch) adopted.push(watch);
    }
    return adopted;
  }

  async save(watch: PersistedWatch): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const file: WatchFile = { formatVersion: 1, owner: this.#owner, watch };
    const target = this.#recordPath(watch.id);
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.#recordPath(id), { force: true });
  }

  async #adoptFile(name: string): Promise<PersistedWatch | undefined> {
    const source = path.join(this.#directory, name);
    let parsed: WatchFile;
    try {
      parsed = parseWatchFile(await readFile(source, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await rename(source, `${source}.${Date.now()}.invalid`).catch(() => undefined);
      throw new Error(`Set aside unreadable watch record ${name}: ${String(error)}`);
    }
    if (name.endsWith(RECORD_SUFFIX) && ownerAlive(parsed.owner, this.#owner)) return undefined;
    const claim = `${this.#recordPath(parsed.watch.id)}${CLAIM_MARKER}${this.#owner.pid}`;
    try {
      await rename(source, claim);
    } catch (error) {
      // Another Runtime claimed it first.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    await this.save(parsed.watch);
    await rm(claim, { force: true });
    return parsed.watch;
  }

  #recordPath(id: string): string {
    return path.join(this.#directory, `${id}${RECORD_SUFFIX}`);
  }
}
