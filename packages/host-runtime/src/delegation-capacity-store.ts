import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessModelRef, HarnessThinkingOptionId } from "@codexhost/harness-adapter";
import type { RoutedHarnessId } from "@codexhost/protocol-core";
import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

import { codexhostDataDirectory } from "./external-clients.js";
import { withRemoteAppServerSocketInitializationLock as withFileMutationLock } from "./remote-socket-lock.js";

/**
 * A start waiting for a free slot, as kept on disk. Unlike a watch it holds the
 * task text, because the Thread does not exist until the start runs.
 */
export interface PersistedQueuedDelegation {
  delegationId: string;
  threadId: string;
  turnId: string;
  harnessId: RoutedHarnessId;
  task: string;
  taskName?: string;
  cwd: string;
  parentThreadId: string;
  requestId?: string;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  title: string;
  taskDigest: string;
  /** Epoch milliseconds; orders the queue. */
  queuedAt: number;
  /** The start had begun when this record was written. */
  starting?: boolean;
}

export interface DelegationQueueStore {
  /** Takes over the queues of Runtimes that have exited and returns their entries. */
  adopt(): Promise<PersistedQueuedDelegation[]>;
  /** Replaces this Runtime's queue; an empty queue removes its record. */
  save(entries: readonly PersistedQueuedDelegation[]): Promise<void>;
}

interface Owner {
  pid: number;
  /** Boot time in seconds, so a pid reused after a reboot is not mistaken for the owner. */
  boot: number;
  /** Tells this process from an earlier one that had the same pid. */
  instance: string;
}

interface QueueFile {
  formatVersion: 1;
  owner: Owner;
  queue: PersistedQueuedDelegation[];
}

const RECORD_SUFFIX = ".json";
const CLAIM_MARKER = ".claim-";
const BOOT_TOLERANCE_SECONDS = 5;
const REQUIRED_TEXT = [
  "delegationId",
  "threadId",
  "turnId",
  "harnessId",
  "task",
  "cwd",
  "parentThreadId",
  "title",
  "taskDigest",
] as const;

export function defaultDelegationQueueDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), "delegation-queue");
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
  if (owner.instance === self.instance) return true;
  if (Math.abs(owner.boot - self.boot) > BOOT_TOLERANCE_SECONDS) return false;
  // This process holds the pid now, so the record's writer has exited.
  if (owner.pid === self.pid) return false;
  return processAlive(owner.pid);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseEntry(value: unknown): PersistedQueuedDelegation {
  const entry = value as Partial<Record<keyof PersistedQueuedDelegation, unknown>> | null;
  if (
    typeof entry !== "object" ||
    entry === null ||
    REQUIRED_TEXT.some((key) => !text(entry[key])) ||
    !Number.isFinite(entry.queuedAt) ||
    (entry.taskName !== undefined && !text(entry.taskName)) ||
    (entry.requestId !== undefined && !text(entry.requestId)) ||
    (entry.model !== undefined && !harnessModelRefSchema.safeParse(entry.model).success) ||
    (entry.thinkingOptionId !== undefined &&
      !harnessThinkingOptionIdSchema.safeParse(entry.thinkingOptionId).success) ||
    (entry.starting !== undefined && typeof entry.starting !== "boolean")
  ) {
    throw new Error("unrecognized queued delegation");
  }
  return entry as PersistedQueuedDelegation;
}

function parseQueueFile(content: string): QueueFile {
  const value = JSON.parse(content) as Partial<QueueFile> | null;
  const owner = value?.owner;
  if (
    value?.formatVersion !== 1 ||
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    !Number.isFinite(owner.boot) ||
    !text(owner.instance) ||
    !Array.isArray(value.queue)
  ) {
    throw new Error("unrecognized delegation queue record");
  }
  return { formatVersion: 1, owner, queue: value.queue.map(parseEntry) };
}

/**
 * One file per Runtime process holding its whole queue. Several Runtimes may
 * share the data directory; each writes only its own file, and a starting
 * Runtime adopts the files of Runtimes that have exited. Adoption claims a file
 * with an atomic rename, so only one Runtime takes it over.
 */
export class FileDelegationQueueStore implements DelegationQueueStore {
  readonly #directory: string;
  readonly #diagnose: (error: unknown) => void;
  readonly #owner: Owner = {
    pid: process.pid,
    boot: Math.round(Date.now() / 1_000 - os.uptime()),
    instance: randomBytes(6).toString("hex"),
  };
  readonly #path: string;

  constructor(directory: string, diagnose: (error: unknown) => void = () => undefined) {
    this.#directory = directory;
    this.#diagnose = diagnose;
    this.#path = path.join(directory, `${this.#owner.pid}-${this.#owner.instance}${RECORD_SUFFIX}`);
  }

  async adopt(): Promise<PersistedQueuedDelegation[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const adopted = new Map<string, PersistedQueuedDelegation>();
    const claims: string[] = [];
    for (const name of names) {
      const claimAt = name.indexOf(CLAIM_MARKER);
      // A claim left by an adopter that exited before finishing is adopted again.
      const claimer =
        claimAt >= 0 ? Number(name.slice(claimAt + CLAIM_MARKER.length).split(".")[0]) : NaN;
      if (claimAt < 0 ? !name.endsWith(RECORD_SUFFIX) : !this.#abandonedClaim(claimer)) continue;
      const claimed = await withFileMutationLock(`${this.#directory}.adoption`, () =>
        this.#claim(name, claimAt < 0),
      ).catch((error: unknown) => {
        this.#diagnose(error);
        return undefined;
      });
      if (!claimed) continue;
      claims.push(claimed.path);
      for (const entry of claimed.queue) {
        if (!adopted.has(entry.threadId)) adopted.set(entry.threadId, entry);
      }
    }
    const queue = [...adopted.values()].sort((left, right) => left.queuedAt - right.queuedAt);
    if (claims.length > 0) {
      await this.save(queue);
      // Saved under this Runtime first, so a crash here repeats entries instead of losing them.
      await Promise.all(claims.map((claim) => rm(claim, { force: true })));
    }
    return queue;
  }

  async save(entries: readonly PersistedQueuedDelegation[]): Promise<void> {
    if (entries.length === 0) {
      await rm(this.#path, { force: true });
      return;
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const file: QueueFile = { formatVersion: 1, owner: this.#owner, queue: [...entries] };
    const temporary = `${this.#path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #abandonedClaim(claimer: number): boolean {
    return Number.isSafeInteger(claimer) && claimer !== process.pid && !processAlive(claimer);
  }

  async #claim(
    name: string,
    record: boolean,
  ): Promise<{ path: string; queue: PersistedQueuedDelegation[] } | undefined> {
    const source = path.join(this.#directory, name);
    let parsed: QueueFile;
    try {
      parsed = parseQueueFile(await readFile(source, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await rename(source, `${source}.${Date.now()}.invalid`).catch(() => undefined);
      throw new Error(`Set aside unreadable delegation queue record ${name}: ${String(error)}`);
    }
    if (record && ownerAlive(parsed.owner, this.#owner)) return undefined;
    // Only the writer changes its file, and it has exited, so the content read above is current.
    const base = record ? name : name.slice(0, name.indexOf(CLAIM_MARKER));
    const claim = path.join(
      this.#directory,
      `${base}${CLAIM_MARKER}${this.#owner.pid}.${randomBytes(4).toString("hex")}`,
    );
    try {
      await rename(source, claim);
    } catch (error) {
      // Another Runtime claimed it first.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return { path: claim, queue: parsed.queue };
  }
}
