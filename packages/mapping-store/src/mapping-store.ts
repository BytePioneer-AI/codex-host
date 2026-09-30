import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import type { HostThreadId, HostTurnId } from "@codexhost/shared-contracts";

import {
  THREAD_METADATA_FIELDS,
  storedDelegationRecordV1Schema,
  storedThreadMetadataV1Schema,
  storedThreadRecordV1Schema,
  type CommitReadyThreadInput,
  type CreateDelegationInput,
  type CreateProvisionalThreadInput,
  type DelegationStatus,
  type FindRecentDelegationInput,
  type RebindSubagentSessionInput,
  type ReplaceReadySessionAfterLastTurnInput,
  type ReplaceReadySessionInput,
  type StoredDelegationRecordV1,
  type StoredThreadMetadataV1,
  type StoredThreadRecordV1,
  type StoredTurnMappingV1,
  type ThreadMetadataPatch,
} from "./records.js";
import {
  readSectionPlacementsFile,
  writeSectionPlacementsFile,
  type StoredSectionPlacementV1,
} from "./section-placements.js";

export type MappingStoreErrorCode =
  | "STORE_LOCKED"
  | "STORE_NOT_INITIALIZED"
  | "THREAD_NOT_FOUND"
  | "DELEGATION_NOT_FOUND"
  | "DUPLICATE_THREAD_ID"
  | "DUPLICATE_DELEGATION_ID"
  | "DUPLICATE_CREATE_REQUEST"
  | "DUPLICATE_NATIVE_SESSION"
  | "MAPPING_CONFLICT"
  | "INVALID_RECORD"
  | "IO_ERROR";

export class MappingStoreError extends Error {
  constructor(
    readonly code: MappingStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MappingStoreError";
  }
}

export interface MappingStoreOptions {
  directory: string;
  instanceId?: string;
  now?: () => Date;
  beforeReplace?: (record: StoredThreadRecordV1) => Promise<void> | void;
}

interface LockRecord {
  pid: number;
  instanceId: string;
  startedAt: string;
  executablePath?: string;
  processStartedAt?: string;
}

interface ProcessIdentity {
  executablePath: string | null;
  startedAt: number | null;
}

function cloneRecord<T>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}

function nativeSessionKey(ref: { harnessId: string; nativeSessionId: string }): string {
  return `${ref.harnessId}\u0000${ref.nativeSessionId}`;
}

function nativeTurnKey(mapping: StoredTurnMappingV1): string {
  const ref = mapping.nativeTurnRef;
  return `${ref.harnessId}\u0000${ref.nativeSessionId}\u0000${ref.nativeTurnKey}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Records must not persist credentials, such as a token embedded in a Git remote URL. */
function withoutUrlCredentials(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return withoutUnparsedUrlCredentials(value);
  }
  // `user:token@host:path` parses as an opaque `user:` URL with no host; treat it as unparsed.
  if (!url.host) return withoutUnparsedUrlCredentials(value);
  // An ssh user name (usually `git`) identifies the account, not a secret.
  const keepUser = url.protocol === "ssh:" || url.protocol === "git+ssh:";
  if (!url.password && (keepUser || !url.username)) return value;
  url.password = "";
  if (!keepUser) url.username = "";
  return url.toString();
}

/**
 * Fallback for text the URL parser rejects (a malformed port, or an scp-style remote such as
 * git@host:path). A user name alone is kept for ssh and scp-style remotes; any other user info
 * in front of the authority is dropped so a malformed value cannot smuggle a token into storage.
 */
function withoutUnparsedUrlCredentials(value: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  const authorityStart = scheme ? scheme[0].length : 0;
  const authorityEnd = value.slice(authorityStart).search(scheme ? /[/?#]/ : /\//);
  const authority =
    authorityEnd === -1
      ? value.slice(authorityStart)
      : value.slice(authorityStart, authorityStart + authorityEnd);
  // A URL password may itself contain "@"; an scp-style path may too, after the host.
  const at = scheme ? authority.lastIndexOf("@") : authority.indexOf("@");
  if (at === -1) return value;
  const userInfo = authority.slice(0, at);
  const protocol = scheme?.[1]?.toLowerCase();
  const keepUser = scheme ? protocol === "ssh" || protocol === "git+ssh" : true;
  const kept = keepUser && !userInfo.includes(":") ? `${userInfo}@` : "";
  return value.slice(0, authorityStart) + kept + value.slice(authorityStart + at + 1);
}

/** The Desktop metadata file content for a record, or null when it carries none. */
function threadMetadataOf(record: StoredThreadRecordV1): StoredThreadMetadataV1 | null {
  const fields = Object.fromEntries(
    THREAD_METADATA_FIELDS.filter((name) => record[name] !== undefined).map((name) => [
      name,
      record[name],
    ]),
  );
  if (Object.keys(fields).length === 0) return null;
  return { formatVersion: 1, hostThreadId: record.hostThreadId, ...fields };
}

/** The record as written to the Thread file, which older releases must still accept. */
function withoutThreadMetadata(record: StoredThreadRecordV1): StoredThreadRecordV1 {
  const { projectId, daybreakEnabled, gitInfo, ...core } = record;
  void [projectId, daybreakEnabled, gitInfo];
  return core;
}

function withThreadMetadata(
  record: StoredThreadRecordV1,
  metadata: StoredThreadMetadataV1,
): StoredThreadRecordV1 {
  const core = withoutThreadMetadata(record);
  for (const name of THREAD_METADATA_FIELDS) {
    if (metadata[name] !== undefined) Object.assign(core, { [name]: metadata[name] });
  }
  return core;
}

function applyThreadMetadataPatch(
  current: StoredThreadRecordV1,
  patch: ThreadMetadataPatch,
): StoredThreadRecordV1 {
  const next = { ...current };
  if (patch.projectId !== undefined) {
    if (patch.projectId === null) delete next.projectId;
    else next.projectId = patch.projectId;
  }
  if (patch.daybreakEnabled !== undefined) next.daybreakEnabled = patch.daybreakEnabled;
  if (patch.gitInfo !== undefined) {
    const gitInfo: NonNullable<StoredThreadRecordV1["gitInfo"]> = {};
    for (const name of ["branch", "originUrl", "sha"] as const) {
      const value =
        patch.gitInfo[name] === undefined ? current.gitInfo?.[name] : patch.gitInfo[name];
      if (value) gitInfo[name] = name === "originUrl" ? withoutUrlCredentials(value) : value;
    }
    if (Object.keys(gitInfo).length === 0) delete next.gitInfo;
    else next.gitInfo = gitInfo;
  }
  return next;
}

function systemErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function processIdentity(pid: number): ProcessIdentity | null {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (systemErrorCode(error) !== "EPERM") return null;
  }

  if (process.platform !== "win32" && process.platform !== "darwin") {
    return { executablePath: null, startedAt: null };
  }

  try {
    if (process.platform === "darwin") {
      // PID existence is insufficient after reuse. Query only on lock contention;
      // lstart has second precision, covered by the existing start-time tolerance.
      const result = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C" },
        timeout: 1_000,
      }).trim();
      const startedAt = Date.parse(result);
      return { executablePath: null, startedAt: Number.isFinite(startedAt) ? startedAt : null };
    }
    const query = [
      "$ErrorActionPreference = 'Stop'",
      `$process = Get-Process -Id ${pid}`,
      "$process | Select-Object Path, StartTime | ConvertTo-Json -Compress",
    ].join("; ");
    const result = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", query],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    ).trim();
    if (!result) return { executablePath: null, startedAt: null };
    const parsed = JSON.parse(result) as { Path?: unknown; StartTime?: unknown };
    const executablePath = typeof parsed.Path === "string" ? parsed.Path : null;
    const startedAt = typeof parsed.StartTime === "string" ? Date.parse(parsed.StartTime) : NaN;
    return { executablePath, startedAt: Number.isFinite(startedAt) ? startedAt : null };
  } catch {
    // If process metadata cannot be queried, preserve the live-lock failure mode.
    return { executablePath: null, startedAt: null };
  }
}

function normalizeExecutablePath(value: string): string {
  return process.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
}

function isNodeExecutable(value: string): boolean {
  const normalized = normalizeExecutablePath(value);
  return normalized.endsWith("\\node.exe") || normalized.endsWith("/node");
}

function lockOwnerIsLive(lock: Partial<LockRecord>): boolean {
  if (typeof lock.pid !== "number") return false;
  if (lock.pid === process.pid) {
    if (
      lock.executablePath &&
      normalizeExecutablePath(lock.executablePath) !== normalizeExecutablePath(process.execPath)
    ) {
      return false;
    }
    if (lock.processStartedAt) {
      const expected = Date.parse(lock.processStartedAt);
      const actual = Date.now() - process.uptime() * 1_000;
      if (Number.isFinite(expected) && Math.abs(actual - expected) > 5_000) return false;
    }
    return true;
  }
  const identity = processIdentity(lock.pid);
  if (!identity) return false;
  if (process.platform !== "win32" && process.platform !== "darwin") return true;

  if (identity.executablePath && lock.executablePath) {
    if (
      normalizeExecutablePath(identity.executablePath) !==
      normalizeExecutablePath(lock.executablePath)
    ) {
      return false;
    }
  } else if (
    identity.executablePath &&
    !lock.executablePath &&
    !isNodeExecutable(identity.executablePath)
  ) {
    // Legacy locks have no executable identity. A reused PID owned by a non-Node
    // process cannot be a live Host Runtime lock.
    return false;
  }

  if (lock.processStartedAt && identity.startedAt !== null) {
    const expected = Date.parse(lock.processStartedAt);
    if (Number.isFinite(expected) && Math.abs(identity.startedAt - expected) > 5_000) {
      return false;
    }
  }
  return true;
}

export class MappingStore {
  readonly #backupsDirectory: string;
  readonly #delegationsDirectory: string;
  readonly #beforeReplace: MappingStoreOptions["beforeReplace"];
  readonly #directory: string;
  readonly #instanceId: string;
  readonly #lockPath: string;
  readonly #metadataDirectory: string;
  readonly #now: () => Date;
  readonly #quarantineDirectory: string;
  readonly #sectionsDirectory: string;
  readonly #threadsDirectory: string;
  readonly #records = new Map<HostThreadId, StoredThreadRecordV1>();
  readonly #delegations = new Map<HostThreadId, StoredDelegationRecordV1>();
  readonly #delegationRequests = new Map<string, HostThreadId>();
  readonly #delegationChildren = new Map<HostThreadId, HostThreadId>();
  readonly #createRequests = new Map<string, HostThreadId>();
  readonly #nativeSessions = new Map<string, HostThreadId>();
  readonly #hostTurns = new Map<HostTurnId, HostThreadId>();
  readonly #nativeTurns = new Map<string, HostTurnId>();
  #sectionPlacements: StoredSectionPlacementV1[] = [];
  // ponytail: A Store-wide queue caps write concurrency at one; shard only if measured throughput requires it.
  #writeTail: Promise<void> = Promise.resolve();
  #initialized = false;
  #lockHandle: FileHandle | null = null;

  constructor(options: MappingStoreOptions) {
    this.#directory = path.resolve(options.directory);
    this.#threadsDirectory = path.join(this.#directory, "threads");
    this.#delegationsDirectory = path.join(this.#directory, "delegations");
    this.#backupsDirectory = path.join(this.#directory, "backups");
    this.#quarantineDirectory = path.join(this.#directory, "quarantine");
    this.#sectionsDirectory = path.join(this.#directory, "sections");
    this.#metadataDirectory = path.join(this.#directory, "thread-metadata");
    this.#lockPath = path.join(this.#directory, "store.lock");
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
    this.#beforeReplace = options.beforeReplace;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await Promise.all([
      mkdir(this.#threadsDirectory, { recursive: true }),
      mkdir(this.#delegationsDirectory, { recursive: true }),
      mkdir(this.#backupsDirectory, { recursive: true }),
      mkdir(this.#quarantineDirectory, { recursive: true }),
      mkdir(this.#sectionsDirectory, { recursive: true }),
      mkdir(this.#metadataDirectory, { recursive: true }),
    ]);
    await this.#acquireLock();
    try {
      await this.#cleanupResidue();
      const names = (await readdir(this.#threadsDirectory)).filter((name) =>
        name.endsWith(".json"),
      );
      for (const name of names) {
        const primary = path.join(this.#threadsDirectory, name);
        const backup = path.join(this.#backupsDirectory, name);
        let record: StoredThreadRecordV1 | null = null;
        try {
          record = await this.#readRecord(primary, name);
        } catch (primaryError) {
          try {
            record = await this.#readRecord(backup, name);
            await this.#replaceFile(primary, record, false);
          } catch (backupError) {
            const quarantine = path.join(
              this.#quarantineDirectory,
              `${name}.${this.#now().getTime()}.invalid`,
            );
            await rename(primary, quarantine).catch(() => undefined);
            void primaryError;
            void backupError;
            continue;
          }
        }
        if (record.state === "creating" && !record.nativeSessionRef) {
          await rm(primary, { force: true });
          await rm(backup, { force: true });
          await rm(this.#metadataPath(record.hostThreadId), { force: true });
          continue;
        }
        const metadata = await this.#readMetadata(record.hostThreadId);
        if (metadata) {
          record = withThreadMetadata(record, metadata);
        } else if (threadMetadataOf(record)) {
          // Pre-release builds wrote metadata inline; move it out so older releases can load the record.
          await this.#writeMetadataFile(record.hostThreadId, threadMetadataOf(record));
          await this.#replaceFile(primary, record, false);
        }
        this.#records.set(record.hostThreadId, record);
      }
      // An older release may have removed a Thread without knowing about its metadata file.
      await Promise.all(
        (await readdir(this.#metadataDirectory))
          .filter(
            (name) =>
              name.endsWith(".json") && !this.#records.has(name.slice(0, -5) as HostThreadId),
          )
          .map((name) => rm(path.join(this.#metadataDirectory, name), { force: true })),
      );
      const delegationNames = (await readdir(this.#delegationsDirectory)).filter((name) =>
        name.endsWith(".json"),
      );
      for (const name of delegationNames) {
        const file = path.join(this.#delegationsDirectory, name);
        try {
          const parsed = storedDelegationRecordV1Schema.parse(
            JSON.parse(await readFile(file, "utf8")),
          ) as StoredDelegationRecordV1;
          if (`${parsed.delegationId}.json` !== name) throw new Error("filename mismatch");
          this.#delegations.set(parsed.delegationId, parsed);
        } catch {
          const quarantine = path.join(
            this.#quarantineDirectory,
            `${name}.${this.#now().getTime()}.invalid-delegation`,
          );
          await rename(file, quarantine).catch(() => undefined);
        }
      }
      try {
        this.#sectionPlacements = await readSectionPlacementsFile(this.#sectionPlacementsPath);
      } catch {
        // Placements are presentation state; losing them must not block Thread access.
        await rename(
          this.#sectionPlacementsPath,
          path.join(
            this.#quarantineDirectory,
            `section-placements.json.${this.#now().getTime()}.invalid`,
          ),
        ).catch(() => undefined);
        this.#sectionPlacements = [];
      }
      this.#rebuildIndexes();
      this.#initialized = true;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async getThread(hostThreadId: HostThreadId): Promise<StoredThreadRecordV1 | null> {
    this.#requireInitialized();
    const record = this.#records.get(hostThreadId);
    return record ? cloneRecord(record) : null;
  }

  async listThreads(): Promise<StoredThreadRecordV1[]> {
    this.#requireInitialized();
    return [...this.#records.values()].map(cloneRecord);
  }

  async getThreadByCreateRequest(createRequestId: string): Promise<StoredThreadRecordV1 | null> {
    this.#requireInitialized();
    const hostThreadId = this.#createRequests.get(createRequestId);
    return hostThreadId ? this.getThread(hostThreadId) : null;
  }

  async getDelegation(delegationId: HostThreadId): Promise<StoredDelegationRecordV1 | null> {
    this.#requireInitialized();
    const record = this.#delegations.get(delegationId);
    return record ? cloneRecord(record) : null;
  }

  async getDelegationByChild(
    childHostThreadId: HostThreadId,
  ): Promise<StoredDelegationRecordV1 | null> {
    this.#requireInitialized();
    const delegationId = this.#delegationChildren.get(childHostThreadId);
    return delegationId ? this.getDelegation(delegationId) : null;
  }

  async findDelegationByRequest(requestId: string): Promise<StoredDelegationRecordV1 | null> {
    this.#requireInitialized();
    const delegationId = this.#delegationRequests.get(requestId);
    return delegationId ? this.getDelegation(delegationId) : null;
  }

  async listDelegations(parentHostThreadId?: HostThreadId): Promise<StoredDelegationRecordV1[]> {
    this.#requireInitialized();
    return [...this.#delegations.values()]
      .filter((record) => !parentHostThreadId || record.parentHostThreadId === parentHostThreadId)
      .map(cloneRecord);
  }

  async findRecentDelegation(
    input: FindRecentDelegationInput,
  ): Promise<StoredDelegationRecordV1 | null> {
    this.#requireInitialized();
    const threshold = input.since.getTime();
    const found = [...this.#delegations.values()]
      .filter(
        (record) =>
          record.parentHostThreadId === input.parentHostThreadId &&
          record.targetHarnessId === input.targetHarnessId &&
          record.taskDigest === input.taskDigest &&
          Date.parse(record.createdAt) >= threshold,
      )
      .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    return found ? cloneRecord(found) : null;
  }

  async createDelegation(input: CreateDelegationInput): Promise<StoredDelegationRecordV1> {
    this.#requireInitialized();
    if (this.#delegations.has(input.delegationId)) {
      throw new MappingStoreError("DUPLICATE_DELEGATION_ID", "Delegation ID already exists");
    }
    if (this.#delegationChildren.has(input.childHostThreadId)) {
      throw new MappingStoreError("MAPPING_CONFLICT", "Child Thread already has a Delegation");
    }
    if (input.requestId && this.#delegationRequests.has(input.requestId)) {
      throw new MappingStoreError(
        "DUPLICATE_CREATE_REQUEST",
        "Delegation Request ID already exists",
      );
    }
    const timestamp = this.#now().toISOString();
    const record = storedDelegationRecordV1Schema.parse({
      formatVersion: 1,
      revision: 1,
      ...input,
      status: input.status ?? "creating",
      createdAt: timestamp,
      updatedAt: timestamp,
    }) as StoredDelegationRecordV1;
    await this.#replaceDelegationFile(record);
    this.#delegations.set(record.delegationId, record);
    this.#rebuildIndexes();
    return cloneRecord(record);
  }

  async setDelegationStatus(
    delegationId: HostThreadId,
    status: DelegationStatus,
  ): Promise<StoredDelegationRecordV1> {
    this.#requireInitialized();
    const current = this.#delegations.get(delegationId);
    if (!current) {
      throw new MappingStoreError("DELEGATION_NOT_FOUND", "Delegation was not found");
    }
    if (current.status === status) return cloneRecord(current);
    const terminal = new Set<DelegationStatus>(["completed", "failed", "interrupted"]);
    if (terminal.has(current.status) && !terminal.has(status)) return cloneRecord(current);
    const next = storedDelegationRecordV1Schema.parse({
      ...current,
      revision: current.revision + 1,
      status,
      updatedAt: this.#now().toISOString(),
    }) as StoredDelegationRecordV1;
    await this.#replaceDelegationFile(next);
    this.#delegations.set(delegationId, next);
    this.#rebuildIndexes();
    return cloneRecord(next);
  }

  async removeDelegation(delegationId: HostThreadId): Promise<void> {
    this.#requireInitialized();
    await rm(this.#delegationPath(delegationId), { force: true });
    this.#delegations.delete(delegationId);
    this.#rebuildIndexes();
  }

  async findThreadByTurn(hostTurnId: HostTurnId): Promise<StoredThreadRecordV1 | null> {
    this.#requireInitialized();
    const threadId = this.#hostTurns.get(hostTurnId);
    return threadId ? this.getThread(threadId) : null;
  }

  async createProvisional(input: CreateProvisionalThreadInput): Promise<StoredThreadRecordV1> {
    this.#requireInitialized();
    let result: StoredThreadRecordV1 | null = null;
    await this.#enqueue(async () => {
      const existingThreadId = this.#createRequests.get(input.createRequestId);
      if (existingThreadId) {
        const existing = this.#records.get(existingThreadId);
        if (!existing) throw new MappingStoreError("IO_ERROR", "Create request index is stale");
        result = cloneRecord(existing);
        return;
      }
      if (this.#records.has(input.hostThreadId)) {
        throw new MappingStoreError("DUPLICATE_THREAD_ID", "Host Thread ID already exists");
      }
      const timestamp = this.#now().toISOString();
      const record = storedThreadRecordV1Schema.parse({
        formatVersion: 1,
        revision: 1,
        hostThreadId: input.hostThreadId,
        createRequestId: input.createRequestId,
        harnessId: input.harnessId,
        state: "creating",
        cwd: input.cwd,
        title: input.title ?? "",
        archived: false,
        transportModelId: input.transportModelId,
        ephemeral: input.ephemeral,
        historyMode: input.historyMode,
        ...(input.forkSource ? { forkSource: input.forkSource } : {}),
        ...(input.subagent ? { subagent: input.subagent } : {}),
        turnMappings: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }) as StoredThreadRecordV1;
      await this.#writeNew(record);
      result = cloneRecord(record);
    });
    if (!result) throw new MappingStoreError("IO_ERROR", "Provisional create produced no result");
    return result;
  }

  async commitReady(input: CommitReadyThreadInput): Promise<StoredThreadRecordV1> {
    return this.#update(input.hostThreadId, (current) => ({
      ...current,
      state: "ready",
      nativeSessionRef: input.nativeSessionRef,
      turnMappings: this.#mergeMappings(current.turnMappings, input.turnMappings ?? []),
    }));
  }

  // Keep native ref, Turn mappings and the indexed create request in one serialized
  // record mutation; separate setters could leave a child pointing at mixed Sessions.
  async rebindSubagentSession(input: RebindSubagentSessionInput): Promise<StoredThreadRecordV1> {
    return this.#update(input.hostThreadId, (current) => {
      const parent = this.#records.get(input.parentHostThreadId);
      if (
        current.state !== "ready" ||
        !current.nativeSessionRef ||
        current.subagent?.parentHostThreadId !== input.parentHostThreadId ||
        parent?.state !== "ready" ||
        parent.harnessId !== current.harnessId ||
        input.previousNativeSessionRef.harnessId !== current.harnessId ||
        input.nativeSessionRef.harnessId !== current.harnessId ||
        !sameJson(parent.nativeSessionRef, input.nativeSessionRef)
      )
        throw new MappingStoreError(
          "MAPPING_CONFLICT",
          "Subagent replacement must belong to its current parent Session",
        );
      if (
        sameJson(current.nativeSessionRef, input.nativeSessionRef) &&
        current.createRequestId === input.createRequestId
      )
        return null;
      if (!sameJson(current.nativeSessionRef, input.previousNativeSessionRef)) {
        throw new MappingStoreError(
          "MAPPING_CONFLICT",
          "Subagent replacement source Session is stale",
        );
      }
      const nativeSessionId = input.nativeSessionRef.nativeSessionId;
      return {
        ...current,
        createRequestId: input.createRequestId,
        nativeSessionRef: input.nativeSessionRef,
        turnMappings: current.turnMappings.map((mapping) => ({
          ...mapping,
          nativeTurnRef: { ...mapping.nativeTurnRef, nativeSessionId },
          ...(mapping.nativeCheckpointRef
            ? { nativeCheckpointRef: { ...mapping.nativeCheckpointRef, nativeSessionId } }
            : {}),
        })),
      };
    });
  }

  async replaceReadySession(input: ReplaceReadySessionInput): Promise<StoredThreadRecordV1> {
    return this.#update(input.hostThreadId, (current) => {
      if (
        current.state !== "ready" ||
        !current.nativeSessionRef ||
        current.revision !== input.expectedRevision ||
        !sameJson(current.nativeSessionRef, input.expectedNativeSessionRef) ||
        !current.forkSource ||
        current.forkSource.hostThreadId !== input.forkSource.hostThreadId ||
        current.nativeSessionRef.nativeSessionId === input.nativeSessionRef.nativeSessionId ||
        input.turnMappings.length < 1 ||
        input.turnMappings.length >= current.turnMappings.length ||
        input.turnMappings.some(
          ({ hostTurnId }, index) => hostTurnId !== current.turnMappings[index]?.hostTurnId,
        )
      ) {
        throw new MappingStoreError(
          "MAPPING_CONFLICT",
          "Ready Session replacement must match the expected record and retain an exact shorter derived prefix",
        );
      }
      return {
        ...current,
        nativeSessionRef: input.nativeSessionRef,
        turnMappings: input.turnMappings,
        forkSource: input.forkSource,
      };
    });
  }

  async replaceReadySessionAfterLastTurn(
    input: ReplaceReadySessionAfterLastTurnInput,
  ): Promise<StoredThreadRecordV1> {
    return this.#update(input.hostThreadId, (current) => {
      if (
        current.state !== "ready" ||
        !current.nativeSessionRef ||
        current.revision !== input.expectedRevision ||
        !sameJson(current.nativeSessionRef, input.expectedNativeSessionRef) ||
        input.turnMappings.length !== current.turnMappings.length - 1 ||
        input.turnMappings.some(
          ({ hostTurnId }, index) => hostTurnId !== current.turnMappings[index]?.hostTurnId,
        )
      ) {
        throw new MappingStoreError(
          "MAPPING_CONFLICT",
          "Last-Turn Session replacement must match the expected record and retain the exact shorter Host Turn prefix",
        );
      }
      return {
        ...current,
        nativeSessionRef: input.nativeSessionRef,
        turnMappings: input.turnMappings,
      };
    });
  }

  async upsertTurnMappings(
    hostThreadId: HostThreadId,
    mappings: StoredTurnMappingV1[],
  ): Promise<StoredThreadRecordV1> {
    return this.#update(hostThreadId, (current) => ({
      ...current,
      turnMappings: this.#mergeMappings(current.turnMappings, mappings),
    }));
  }

  async reconcileTurnMappings(
    hostThreadId: HostThreadId,
    mappings: StoredTurnMappingV1[],
  ): Promise<StoredThreadRecordV1> {
    return this.#update(hostThreadId, (current) => {
      if (current.state !== "ready" || !current.nativeSessionRef) {
        throw new MappingStoreError(
          "MAPPING_CONFLICT",
          "Only a ready Thread can reconcile Snapshot mappings",
        );
      }

      const byHost = new Map(
        current.turnMappings.map((mapping) => [mapping.hostTurnId, mapping] as const),
      );
      const byNative = new Map(
        current.turnMappings.map((mapping) => [nativeTurnKey(mapping), mapping] as const),
      );
      const seenHost = new Set<string>();
      const seenNative = new Set<string>();
      const ordered = mappings.map((update) => {
        const hostMatch = byHost.get(update.hostTurnId);
        const nativeMatch = byNative.get(nativeTurnKey(update));
        if (hostMatch && nativeMatch && hostMatch !== nativeMatch) {
          throw new MappingStoreError("MAPPING_CONFLICT", "Turn identity mapping conflicts");
        }
        if (hostMatch && !sameJson(hostMatch.nativeTurnRef, update.nativeTurnRef)) {
          throw new MappingStoreError("MAPPING_CONFLICT", "Host Turn maps to another Native Turn");
        }
        if (nativeMatch && nativeMatch.hostTurnId !== update.hostTurnId) {
          throw new MappingStoreError("MAPPING_CONFLICT", "Native Turn maps to another Host Turn");
        }
        if (seenHost.has(update.hostTurnId) || seenNative.has(nativeTurnKey(update))) {
          throw new MappingStoreError(
            "MAPPING_CONFLICT",
            "Snapshot reconciliation contains a duplicate Turn mapping",
          );
        }
        seenHost.add(update.hostTurnId);
        seenNative.add(nativeTurnKey(update));
        return { ...update };
      });

      return sameJson(current.turnMappings, ordered) ? null : { ...current, turnMappings: ordered };
    });
  }

  async setTitle(hostThreadId: HostThreadId, title: string): Promise<StoredThreadRecordV1> {
    return this.#update(hostThreadId, (current) => ({ ...current, title }));
  }

  async setTransportModelId(
    hostThreadId: HostThreadId,
    transportModelId: string,
  ): Promise<StoredThreadRecordV1> {
    return this.#update(hostThreadId, (current) =>
      current.transportModelId === transportModelId ? null : { ...current, transportModelId },
    );
  }

  async setArchived(hostThreadId: HostThreadId, archived: boolean): Promise<StoredThreadRecordV1> {
    return this.#update(hostThreadId, (current) =>
      current.archived === archived ? null : { ...current, archived },
    );
  }

  /**
   * Patch Desktop metadata. With `ifProjectId`, the patch applies only while the
   * stored assignment still equals it; otherwise the current record is returned.
   */
  async updateMetadata(
    hostThreadId: HostThreadId,
    patch: ThreadMetadataPatch,
    options: { ifProjectId?: string } = {},
  ): Promise<StoredThreadRecordV1> {
    return this.#update(hostThreadId, (current) => {
      if (options.ifProjectId !== undefined && current.projectId !== options.ifProjectId) {
        return null;
      }
      const next = applyThreadMetadataPatch(current, patch);
      return sameJson(next, current) ? null : next;
    });
  }

  /** Section placements of stored External Threads, in insertion order. */
  async listSectionPlacements(): Promise<StoredSectionPlacementV1[]> {
    this.#requireInitialized();
    // A removed Thread's placement still names its successor; Threads anchored to it
    // follow that chain so they keep their position instead of falling to the end.
    const removedSuccessors = new Map<string, string | null>(
      this.#sectionPlacements
        .filter((placement) => !this.#records.has(placement.hostThreadId))
        .map((placement) => [placement.hostThreadId, placement.beforeThreadId]),
    );
    return this.#sectionPlacements
      .filter((placement) => this.#records.has(placement.hostThreadId))
      .map((placement) => {
        const next = cloneRecord(placement);
        const visited = new Set<string>();
        while (next.beforeThreadId !== null && removedSuccessors.has(next.beforeThreadId)) {
          if (visited.has(next.beforeThreadId)) {
            next.beforeThreadId = null;
            break;
          }
          visited.add(next.beforeThreadId);
          next.beforeThreadId = removedSuccessors.get(next.beforeThreadId) ?? null;
        }
        return next;
      });
  }

  /** Atomically replaces every section placement; placements of removed Threads are dropped. */
  async replaceSectionPlacements(
    placements: readonly StoredSectionPlacementV1[],
  ): Promise<StoredSectionPlacementV1[]> {
    this.#requireInitialized();
    let result: StoredSectionPlacementV1[] = [];
    await this.#enqueue(async () => {
      const retained = placements.filter((placement) =>
        this.#records.has(placement.hostThreadId as HostThreadId),
      );
      try {
        this.#sectionPlacements = await writeSectionPlacementsFile(
          this.#sectionPlacementsPath,
          retained,
        );
      } catch (error) {
        throw new MappingStoreError("IO_ERROR", "Section placements could not be persisted", {
          cause: error,
        });
      }
      result = this.#sectionPlacements.map((placement) => cloneRecord(placement));
    });
    return result;
  }

  async removeProvisional(hostThreadId: HostThreadId): Promise<void> {
    this.#requireInitialized();
    await this.#enqueue(async () => {
      const record = this.#records.get(hostThreadId);
      if (record?.state === "ready") {
        throw new MappingStoreError(
          "MAPPING_CONFLICT",
          "Ready Thread cannot be removed as provisional",
        );
      }
      await this.#remove(hostThreadId);
    });
  }

  async removeThread(hostThreadId: HostThreadId): Promise<void> {
    this.#requireInitialized();
    await this.#enqueue(() => this.#remove(hostThreadId));
  }

  async #remove(hostThreadId: HostThreadId): Promise<void> {
    if (!this.#records.has(hostThreadId)) return;
    await Promise.all([
      rm(this.#recordPath(hostThreadId), { force: true }),
      rm(this.#backupPath(hostThreadId), { force: true }),
      rm(this.#metadataPath(hostThreadId), { force: true }),
    ]);
    this.#records.delete(hostThreadId);
    this.#rebuildIndexes();
  }

  async close(): Promise<void> {
    await this.#writeTail;
    const handle = this.#lockHandle;
    this.#lockHandle = null;
    this.#initialized = false;
    if (handle) await handle.close().catch(() => undefined);
    try {
      const current = JSON.parse(await readFile(this.#lockPath, "utf8")) as Partial<LockRecord>;
      if (current.instanceId === this.#instanceId) await rm(this.#lockPath, { force: true });
    } catch {
      // Lock cleanup is best effort; the next owner validates the recorded pid.
    }
  }

  async #update(
    hostThreadId: HostThreadId,
    change: (current: StoredThreadRecordV1) => StoredThreadRecordV1 | null,
  ): Promise<StoredThreadRecordV1> {
    this.#requireInitialized();
    let result: StoredThreadRecordV1 | null = null;
    await this.#enqueue(async () => {
      const current = this.#records.get(hostThreadId);
      if (!current)
        throw new MappingStoreError("THREAD_NOT_FOUND", "External Thread was not found");
      const changed = change(cloneRecord(current));
      if (!changed) {
        result = cloneRecord(current);
        return;
      }
      const next = storedThreadRecordV1Schema.parse({
        ...changed,
        revision: current.revision + 1,
        updatedAt: this.#now().toISOString(),
      }) as StoredThreadRecordV1;
      this.#validateGlobal(next, hostThreadId);
      await this.#replaceFile(this.#recordPath(hostThreadId), next, true);
      const metadata = threadMetadataOf(next);
      if (!sameJson(threadMetadataOf(current), metadata)) {
        await this.#writeMetadataFile(hostThreadId, metadata);
      }
      this.#records.set(hostThreadId, next);
      this.#rebuildIndexes();
      result = cloneRecord(next);
    });
    if (!result) throw new MappingStoreError("IO_ERROR", "Thread update produced no result");
    return result;
  }

  #mergeMappings(
    current: StoredTurnMappingV1[],
    updates: StoredTurnMappingV1[],
  ): StoredTurnMappingV1[] {
    const merged = current.map((mapping) => ({ ...mapping }));
    const byHost = new Map(merged.map((mapping) => [mapping.hostTurnId, mapping] as const));
    const byNative = new Map(merged.map((mapping) => [nativeTurnKey(mapping), mapping] as const));
    for (const update of updates) {
      const hostMatch = byHost.get(update.hostTurnId);
      const nativeMatch = byNative.get(nativeTurnKey(update));
      if (hostMatch || nativeMatch) {
        if (!hostMatch || hostMatch !== nativeMatch) {
          throw new MappingStoreError("MAPPING_CONFLICT", "Turn identity mapping conflicts");
        }
        if (!sameJson(hostMatch.nativeTurnRef, update.nativeTurnRef)) {
          throw new MappingStoreError("MAPPING_CONFLICT", "Host Turn maps to another Native Turn");
        }
        if (
          hostMatch.nativeCheckpointRef &&
          update.nativeCheckpointRef &&
          !sameJson(hostMatch.nativeCheckpointRef, update.nativeCheckpointRef)
        ) {
          throw new MappingStoreError("MAPPING_CONFLICT", "Fork Checkpoint identity changed");
        }
        if (!hostMatch.nativeCheckpointRef && update.nativeCheckpointRef) {
          hostMatch.nativeCheckpointRef = update.nativeCheckpointRef;
        }
        continue;
      }
      const added = { ...update };
      merged.push(added);
      byHost.set(added.hostTurnId, added);
      byNative.set(nativeTurnKey(added), added);
    }
    return merged;
  }

  async #writeNew(record: StoredThreadRecordV1): Promise<void> {
    this.#validateGlobal(record, null);
    await this.#replaceFile(this.#recordPath(record.hostThreadId), record, false);
    this.#records.set(record.hostThreadId, record);
    this.#rebuildIndexes();
  }

  async #replaceFile(
    target: string,
    record: StoredThreadRecordV1,
    preserveBackup: boolean,
  ): Promise<void> {
    const temp = `${target}.tmp-${randomUUID()}`;
    let handle: FileHandle | null = null;
    try {
      await this.#beforeReplace?.(cloneRecord(record));
      handle = await open(temp, "wx", constants.S_IRUSR | constants.S_IWUSR);
      await handle.writeFile(`${JSON.stringify(withoutThreadMetadata(record), null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (preserveBackup && (await exists(target))) {
        await copyFile(target, this.#backupPath(record.hostThreadId));
      }
      await rename(temp, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      if (error instanceof MappingStoreError) throw error;
      throw new MappingStoreError("IO_ERROR", "Mapping Store atomic replacement failed", {
        cause: error,
      });
    }
  }

  /** Atomically writes, or with null removes, a Thread's Desktop metadata file. */
  async #writeMetadataFile(
    hostThreadId: HostThreadId,
    metadata: StoredThreadMetadataV1 | null,
  ): Promise<void> {
    const target = this.#metadataPath(hostThreadId);
    const temp = `${target}.tmp-${randomUUID()}`;
    let handle: FileHandle | null = null;
    try {
      if (!metadata) {
        await rm(target, { force: true });
        return;
      }
      handle = await open(temp, "wx", constants.S_IRUSR | constants.S_IWUSR);
      await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      throw new MappingStoreError("IO_ERROR", "Thread metadata atomic replacement failed", {
        cause: error,
      });
    }
  }

  /** Reads a Thread's metadata file; an invalid file is quarantined rather than blocking the Thread. */
  async #readMetadata(hostThreadId: HostThreadId): Promise<StoredThreadMetadataV1 | null> {
    const file = this.#metadataPath(hostThreadId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed = storedThreadMetadataV1Schema.parse(JSON.parse(text));
      if (parsed.hostThreadId !== hostThreadId) throw new Error("Thread ID mismatch");
      return parsed;
    } catch {
      await rename(
        file,
        path.join(
          this.#quarantineDirectory,
          `${hostThreadId}.json.${this.#now().getTime()}.invalid-metadata`,
        ),
      ).catch(() => undefined);
      return null;
    }
  }

  async #replaceDelegationFile(record: StoredDelegationRecordV1): Promise<void> {
    const target = this.#delegationPath(record.delegationId);
    const temp = `${target}.tmp-${randomUUID()}`;
    let handle: FileHandle | null = null;
    try {
      handle = await open(temp, "wx", constants.S_IRUSR | constants.S_IWUSR);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      if (error instanceof MappingStoreError) throw error;
      throw new MappingStoreError("IO_ERROR", "Delegation atomic replacement failed", {
        cause: error,
      });
    }
  }

  async #readRecord(file: string, expectedName: string): Promise<StoredThreadRecordV1> {
    const parsed = storedThreadRecordV1Schema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) {
      throw new MappingStoreError("INVALID_RECORD", "Mapping Store record is invalid", {
        cause: parsed.error,
      });
    }
    if (`${parsed.data.hostThreadId}.json` !== expectedName) {
      throw new MappingStoreError(
        "INVALID_RECORD",
        "Mapping Store filename does not match Thread ID",
      );
    }
    return parsed.data as StoredThreadRecordV1;
  }

  async #cleanupResidue(): Promise<void> {
    const [threadNames, delegationNames, sectionNames, rootNames, metadataNames] =
      await Promise.all([
        readdir(this.#threadsDirectory),
        readdir(this.#delegationsDirectory),
        readdir(this.#sectionsDirectory),
        readdir(this.#directory),
        readdir(this.#metadataDirectory),
      ]);
    await Promise.all([
      ...threadNames
        .filter((name) => name.includes(".tmp-"))
        .map((name) => rm(path.join(this.#threadsDirectory, name), { force: true })),
      ...delegationNames
        .filter((name) => name.includes(".tmp-"))
        .map((name) => rm(path.join(this.#delegationsDirectory, name), { force: true })),
      ...sectionNames
        .filter((name) => name.includes(".tmp-"))
        .map((name) => rm(path.join(this.#sectionsDirectory, name), { force: true })),
      ...metadataNames
        .filter((name) => name.includes(".tmp-"))
        .map((name) => rm(path.join(this.#metadataDirectory, name), { force: true })),
      // Renamed aside by #acquireLock; nothing reads them back, and they accumulate one per run.
      ...rootNames
        .filter((name) => name.startsWith(`${path.basename(this.#lockPath)}.stale-`))
        .map((name) => rm(path.join(this.#directory, name), { force: true })),
    ]);
  }

  async #acquireLock(): Promise<void> {
    const attempt = async (): Promise<FileHandle> => {
      const handle = await open(this.#lockPath, "wx", constants.S_IRUSR | constants.S_IWUSR);
      const lock: LockRecord = {
        pid: process.pid,
        instanceId: this.#instanceId,
        startedAt: this.#now().toISOString(),
        executablePath: process.execPath,
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
      await handle.sync();
      return handle;
    };
    try {
      this.#lockHandle = await attempt();
      return;
    } catch (error) {
      if (systemErrorCode(error) !== "EEXIST") throw error;
    }
    let existing: Partial<LockRecord> = {};
    try {
      existing = JSON.parse(await readFile(this.#lockPath, "utf8")) as Partial<LockRecord>;
    } catch {
      // An invalid lock cannot prove a live owner and is treated as stale.
    }
    if (typeof existing.pid === "number" && lockOwnerIsLive(existing)) {
      throw new MappingStoreError("STORE_LOCKED", "Another codexhost process owns Mapping Store");
    }
    await rename(this.#lockPath, `${this.#lockPath}.stale-${this.#now().getTime()}`).catch(
      () => undefined,
    );
    try {
      this.#lockHandle = await attempt();
    } catch (error) {
      throw new MappingStoreError("STORE_LOCKED", "Mapping Store lock could not be acquired", {
        cause: error,
      });
    }
  }

  #validateGlobal(record: StoredThreadRecordV1, replacing: HostThreadId | null): void {
    const duplicateCreate = this.#createRequests.get(record.createRequestId);
    if (duplicateCreate && duplicateCreate !== replacing) {
      throw new MappingStoreError("DUPLICATE_CREATE_REQUEST", "Create request is already stored");
    }
    if (record.nativeSessionRef && !record.subagent) {
      const duplicateSession = this.#nativeSessions.get(nativeSessionKey(record.nativeSessionRef));
      if (duplicateSession && duplicateSession !== replacing) {
        throw new MappingStoreError("DUPLICATE_NATIVE_SESSION", "Native Session is already mapped");
      }
    }
    for (const mapping of record.turnMappings) {
      const duplicateHostTurn = this.#hostTurns.get(mapping.hostTurnId);
      if (duplicateHostTurn && duplicateHostTurn !== replacing) {
        throw new MappingStoreError("MAPPING_CONFLICT", "Host Turn is already mapped");
      }
      const duplicateNativeTurn = this.#nativeTurns.get(nativeTurnKey(mapping));
      if (duplicateNativeTurn && duplicateNativeTurn !== mapping.hostTurnId) {
        throw new MappingStoreError("MAPPING_CONFLICT", "Native Turn is already mapped");
      }
    }
  }

  #rebuildIndexes(): void {
    this.#createRequests.clear();
    this.#delegationRequests.clear();
    this.#delegationChildren.clear();
    this.#nativeSessions.clear();
    this.#hostTurns.clear();
    this.#nativeTurns.clear();
    for (const delegation of this.#delegations.values()) {
      if (this.#delegationChildren.has(delegation.childHostThreadId)) {
        throw new MappingStoreError("MAPPING_CONFLICT", "Delegation child Thread is duplicated");
      }
      this.#delegationChildren.set(delegation.childHostThreadId, delegation.delegationId);
      if (delegation.requestId) {
        if (this.#delegationRequests.has(delegation.requestId)) {
          throw new MappingStoreError("MAPPING_CONFLICT", "Delegation Request ID is duplicated");
        }
        this.#delegationRequests.set(delegation.requestId, delegation.delegationId);
      }
    }
    for (const record of this.#records.values()) {
      this.#validateGlobal(record, record.hostThreadId);
      this.#createRequests.set(record.createRequestId, record.hostThreadId);
      if (record.nativeSessionRef && !record.subagent) {
        this.#nativeSessions.set(nativeSessionKey(record.nativeSessionRef), record.hostThreadId);
      }
      for (const mapping of record.turnMappings) {
        this.#hostTurns.set(mapping.hostTurnId, record.hostThreadId);
        this.#nativeTurns.set(nativeTurnKey(mapping), mapping.hostTurnId);
      }
    }
  }

  async #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#writeTail.then(operation);
    this.#writeTail = next.catch(() => undefined);
    await next;
  }

  #recordPath(hostThreadId: HostThreadId): string {
    return path.join(this.#threadsDirectory, `${hostThreadId}.json`);
  }

  #delegationPath(delegationId: HostThreadId): string {
    return path.join(this.#delegationsDirectory, `${delegationId}.json`);
  }

  get #sectionPlacementsPath(): string {
    return path.join(this.#sectionsDirectory, "placements.json");
  }

  #metadataPath(hostThreadId: HostThreadId): string {
    return path.join(this.#metadataDirectory, `${hostThreadId}.json`);
  }

  #backupPath(hostThreadId: HostThreadId): string {
    return path.join(this.#backupsDirectory, `${hostThreadId}.json`);
  }

  #requireInitialized(): void {
    if (!this.#initialized) {
      throw new MappingStoreError("STORE_NOT_INITIALIZED", "Mapping Store is not initialized");
    }
  }
}
