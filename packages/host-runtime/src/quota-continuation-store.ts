import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { QuotaContinuationState } from "@codexhost/shared-contracts";

import type { ThreadContinuationEntry } from "./delegation-types.js";

/** Persisted continuation metadata; survives Host Runtime restarts and OS sleep. */
export interface PersistedQuotaContinuation extends ThreadContinuationEntry {
  prompt: string;
  /** Latest Turn ID observed when scheduled, so manual user activity auto-cancels the wait. */
  baselineTurnId?: string;
  targetResetAtMs?: number;
  deadlineMs: number;
  nextCheckAtMs?: number;
  resetGraceMs: number;
  verifyAttempt?: number;
  explicitWaitUntil?: boolean;
  /** A send was started and its outcome was not yet recorded; never double-send after a crash. */
  dispatching?: boolean;
}

export interface QuotaContinuationStore {
  /** Takes over the records of Runtimes that have exited and returns them. */
  adopt(): Promise<PersistedQuotaContinuation[]>;
  save(entry: PersistedQuotaContinuation): Promise<void>;
  remove(id: string): Promise<void>;
}

interface Owner {
  pid: number;
  boot: number;
}

interface ContinuationFile {
  formatVersion: 1;
  owner: Owner;
  continuation: PersistedQuotaContinuation;
}

const RECORD_SUFFIX = ".json";
const CLAIM_MARKER = ".claim-";
const BOOT_TOLERANCE_SECONDS = 5;
const CONTINUATION_ID = /^[A-Za-z0-9-]{1,64}$/u;
const STATES = new Set<QuotaContinuationState>([
  "waitingForReset",
  "verifying",
  "readyToResume",
  "resumed",
  "cancelled",
  "expired",
  "failed",
]);

export function defaultQuotaContinuationDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, "quota-continuations");
}

function currentOwner(): Owner {
  return { pid: process.pid, boot: Math.round(Date.now() / 1_000 - os.uptime()) };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
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

function parseContinuationFile(text: string): ContinuationFile {
  const value = JSON.parse(text) as Partial<ContinuationFile> | null;
  const owner = value?.owner;
  const entry = value?.continuation as Partial<PersistedQuotaContinuation> | undefined;
  if (
    value?.formatVersion !== 1 ||
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    !Number.isFinite(owner.boot) ||
    !entry ||
    typeof entry.id !== "string" ||
    !CONTINUATION_ID.test(entry.id) ||
    typeof entry.threadId !== "string" ||
    typeof entry.harnessId !== "string" ||
    typeof entry.poolKey !== "string" ||
    typeof entry.prompt !== "string" ||
    typeof entry.registeredAt !== "string" ||
    typeof entry.deadlineAt !== "string" ||
    !STATES.has(entry.state as QuotaContinuationState) ||
    !Number.isSafeInteger(entry.priority) ||
    !Number.isFinite(entry.deadlineMs) ||
    !Number.isFinite(entry.minHeadroomPercent) ||
    typeof entry.maxConcurrentPerPool !== "number" ||
    !Number.isSafeInteger(entry.maxConcurrentPerPool) ||
    entry.maxConcurrentPerPool < 1 ||
    typeof entry.resetGraceMs !== "number" ||
    !Number.isSafeInteger(entry.resetGraceMs) ||
    entry.resetGraceMs < 0 ||
    !optionalString(entry.scopeId) ||
    !optionalString(entry.targetResetAt) ||
    !optionalString(entry.nextCheckAt) ||
    !optionalString(entry.resumedAt) ||
    !optionalString(entry.resumedTurnId) ||
    !optionalString(entry.reason) ||
    !optionalString(entry.taskName) ||
    !optionalString(entry.baselineTurnId) ||
    !optionalNumber(entry.targetResetAtMs) ||
    !optionalNumber(entry.nextCheckAtMs) ||
    !optionalNumber(entry.verifyAttempt) ||
    (entry.explicitWaitUntil !== undefined && typeof entry.explicitWaitUntil !== "boolean") ||
    (entry.dispatching !== undefined && typeof entry.dispatching !== "boolean")
  ) {
    throw new Error("unrecognized quota continuation record");
  }
  return value as ContinuationFile;
}

/**
 * One file per continuation, owned by the Runtime process that wrote it.
 * Mirrors `FileDelegationWatchStore` so multiple Runtimes safely adopt exited owners' records.
 */
export class FileQuotaContinuationStore implements QuotaContinuationStore {
  readonly #directory: string;
  readonly #diagnose: (error: unknown) => void;
  readonly #owner = currentOwner();

  constructor(directory: string, diagnose: (error: unknown) => void = () => undefined) {
    this.#directory = directory;
    this.#diagnose = diagnose;
  }

  async adopt(): Promise<PersistedQuotaContinuation[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const adopted: PersistedQuotaContinuation[] = [];
    for (const name of names) {
      const claimAt = name.indexOf(CLAIM_MARKER);
      const isRecord = claimAt < 0 && name.endsWith(RECORD_SUFFIX);
      const claimer =
        claimAt >= 0 ? Number(name.slice(claimAt + CLAIM_MARKER.length).split(".")[0]) : NaN;
      if (!isRecord && !(Number.isSafeInteger(claimer) && !processAlive(claimer))) continue;
      const entry = await this.#adoptFile(name).catch((error: unknown) => {
        this.#diagnose(error);
        return undefined;
      });
      if (entry) adopted.push(entry);
    }
    return adopted;
  }

  async save(continuation: PersistedQuotaContinuation): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const file: ContinuationFile = { formatVersion: 1, owner: this.#owner, continuation };
    const target = this.#recordPath(continuation.id);
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

  async #adoptFile(name: string): Promise<PersistedQuotaContinuation | undefined> {
    const source = path.join(this.#directory, name);
    let text: string;
    let parsed: ContinuationFile;
    try {
      text = await readFile(source, "utf8");
      parsed = parseContinuationFile(text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await rename(source, `${source}.${Date.now()}.invalid`).catch(() => undefined);
      throw new Error(`Set aside unreadable quota continuation record ${name}: ${String(error)}`);
    }
    if (name.endsWith(RECORD_SUFFIX) && ownerAlive(parsed.owner, this.#owner)) return undefined;
    const claim = `${this.#recordPath(parsed.continuation.id)}${CLAIM_MARKER}${this.#owner.pid}.${randomBytes(4).toString("hex")}`;
    try {
      await rename(source, claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if ((await readFile(claim, "utf8").catch(() => undefined)) !== text) {
      await link(claim, source).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await rm(claim, { force: true });
      return undefined;
    }
    await this.save(parsed.continuation);
    await rm(claim, { force: true });
    return parsed.continuation;
  }

  #recordPath(id: string): string {
    return path.join(this.#directory, `${id}${RECORD_SUFFIX}`);
  }
}
