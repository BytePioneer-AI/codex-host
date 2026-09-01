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
  storedDelegationRecordV1Schema,
  storedThreadRecordV1Schema,
  type CommitReadyThreadInput,
  type CreateDelegationInput,
  type CreateProvisionalThreadInput,
  type DelegationStatus,
  type FindRecentDelegationInput,
  type ReplaceReadySessionAfterLastTurnInput,
  type ReplaceReadySessionInput,
  type StoredDelegationRecordV1,
  type StoredThreadRecordV1,
  type StoredTurnMappingV1,
} from "./records.js";

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
  beforeRebuild?: () => void;
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

  if (process.platform !== "win32") {
    return { executablePath: null, startedAt: null };
  }

  try {
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
  if (process.platform !== "win32") return true;

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
  readonly #beforeRebuild: MappingStoreOptions["beforeRebuild"];
  readonly #directory: string;
  readonly #instanceId: string;
  readonly #lockPath: string;
  readonly #now: () => Date;
  readonly #quarantineDirectory: string;
  readonly #threadsDirectory: string;
  readonly #records = new Map<HostThreadId, StoredThreadRecordV1>();
  readonly #delegations = new Map<HostThreadId, StoredDelegationRecordV1>();
  readonly #delegationRequests = new Map<string, HostThreadId>();
  readonly #delegationChildren = new Map<HostThreadId, HostThreadId>();
  readonly #createRequests = new Map<string, HostThreadId>();
  readonly #nativeSessions = new Map<string, HostThreadId>();
  readonly #hostTurns = new Map<HostTurnId, HostThreadId>();
  readonly #nativeTurns = new Map<string, HostTurnId>();
  readonly #writeTails = new Map<HostThreadId, Promise<void>>();
  #mutationTail: Promise<void> = Promise.resolve();
  #initialized = false;
  #lockHandle: FileHandle | null = null;

  constructor(options: MappingStoreOptions) {
    this.#directory = path.resolve(options.directory);
    this.#threadsDirectory = path.join(this.#directory, "threads");
    this.#delegationsDirectory = path.join(this.#directory, "delegations");
    this.#backupsDirectory = path.join(this.#directory, "backups");
    this.#quarantineDirectory = path.join(this.#directory, "quarantine");
    this.#lockPath = path.join(this.#directory, "store.lock");
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
    this.#beforeReplace = options.beforeReplace;
    this.#beforeRebuild = options.beforeRebuild;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await Promise.all([
      mkdir(this.#threadsDirectory, { recursive: true }),
      mkdir(this.#delegationsDirectory, { recursive: true }),
      mkdir(this.#backupsDirectory, { recursive: true }),
      mkdir(this.#quarantineDirectory, { recursive: true }),
    ]);
    await this.#acquireLock();
    try {
      await this.#cleanupTemps();
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
          continue;
        }
        this.#records.set(record.hostThreadId, record);
      }
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
    return this.#serializeMutation(() => this.#createDelegation(input));
  }

  async #createDelegation(input: CreateDelegationInput): Promise<StoredDelegationRecordV1> {
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
    const indexes = this.#snapshotIndexes();
    try {
      await this.#replaceDelegationFile(record);
      this.#delegations.set(record.delegationId, record);
      this.#beforeRebuild?.();
      this.#rebuildIndexes();
    } catch (error) {
      this.#delegations.delete(record.delegationId);
      this.#restoreIndexes(indexes);
      await rm(this.#delegationPath(record.delegationId), { force: true }).catch(() => undefined);
      throw error;
    }
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
    return this.#serializeMutation(() => this.#createProvisional(input));
  }

  async #createProvisional(input: CreateProvisionalThreadInput): Promise<StoredThreadRecordV1> {
    this.#requireInitialized();
    const existingThreadId = this.#createRequests.get(input.createRequestId);
    if (existingThreadId) {
      const existing = this.#records.get(existingThreadId);
      if (!existing) throw new MappingStoreError("IO_ERROR", "Create request index is stale");
      return cloneRecord(existing);
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
    return cloneRecord(record);
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
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

  async replaceReadySession(input: ReplaceReadySessionInput): Promise<StoredThreadRecordV1> {
    return this.#update(input.hostThreadId, (current) => {
      if (
        current.state !== "ready" ||
        !current.nativeSessionRef ||
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
          "Ready Session replacement must retain an exact shorter derived prefix",
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
        input.turnMappings.length !== current.turnMappings.length - 1 ||
        input.turnMappings.some(
          ({ hostTurnId }, index) => hostTurnId !== current.turnMappings[index]?.hostTurnId,
        )
      ) {
        throw new MappingStoreError(
          "MAPPING_CONFLICT",
          "Last-Turn Session replacement must retain the exact shorter Host Turn prefix",
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

  async removeProvisional(hostThreadId: HostThreadId): Promise<void> {
    this.#requireInitialized();
    const record = this.#records.get(hostThreadId);
    if (record?.state === "ready") {
      throw new MappingStoreError(
        "MAPPING_CONFLICT",
        "Ready Thread cannot be removed as provisional",
      );
    }
    await this.#remove(hostThreadId);
  }

  async removeThread(hostThreadId: HostThreadId): Promise<void> {
    this.#requireInitialized();
    await this.#remove(hostThreadId);
  }

  async #remove(hostThreadId: HostThreadId): Promise<void> {
    await this.#enqueue(hostThreadId, async () => {
      if (!this.#records.has(hostThreadId)) return;
      await Promise.all([
        rm(this.#recordPath(hostThreadId), { force: true }),
        rm(this.#backupPath(hostThreadId), { force: true }),
      ]);
      this.#records.delete(hostThreadId);
      this.#rebuildIndexes();
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#writeTails.values());
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
    await this.#enqueue(hostThreadId, async () => {
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
    const indexes = this.#snapshotIndexes();
    try {
      await this.#replaceFile(this.#recordPath(record.hostThreadId), record, false);
      this.#records.set(record.hostThreadId, record);
      this.#beforeRebuild?.();
      this.#rebuildIndexes();
    } catch (error) {
      this.#records.delete(record.hostThreadId);
      this.#restoreIndexes(indexes);
      await rm(this.#recordPath(record.hostThreadId), { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #snapshotIndexes(): Map<string, Map<string, string>> {
    const snapshot = new Map<string, Map<string, string>>();
    snapshot.set("create", new Map(this.#createRequests));
    snapshot.set("delegation", new Map(this.#delegationRequests));
    snapshot.set("children", new Map(this.#delegationChildren));
    snapshot.set("sessions", new Map(this.#nativeSessions));
    snapshot.set("hostTurns", new Map(this.#hostTurns));
    snapshot.set("nativeTurns", new Map(this.#nativeTurns));
    return snapshot;
  }

  #restoreIndexes(snapshot: Map<string, Map<string, string>>): void {
    const restore = (target: Map<string, string>, key: string) => {
      target.clear();
      for (const [k, v] of snapshot.get(key) ?? []) target.set(k, v);
    };
    restore(this.#createRequests, "create");
    restore(this.#delegationRequests, "delegation");
    restore(this.#delegationChildren, "children");
    restore(this.#nativeSessions, "sessions");
    restore(this.#hostTurns, "hostTurns");
    restore(this.#nativeTurns, "nativeTurns");
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
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
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

  async #cleanupTemps(): Promise<void> {
    const [threadNames, delegationNames] = await Promise.all([
      readdir(this.#threadsDirectory),
      readdir(this.#delegationsDirectory),
    ]);
    await Promise.all([
      ...threadNames
        .filter((name) => name.includes(".tmp-"))
        .map((name) => rm(path.join(this.#threadsDirectory, name), { force: true })),
      ...delegationNames
        .filter((name) => name.includes(".tmp-"))
        .map((name) => rm(path.join(this.#delegationsDirectory, name), { force: true })),
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

  async #enqueue(hostThreadId: HostThreadId, operation: () => Promise<void>): Promise<void> {
    const prior = this.#writeTails.get(hostThreadId) ?? Promise.resolve();
    const next = prior.then(operation, operation);
    const settled = next.catch(() => undefined);
    this.#writeTails.set(hostThreadId, settled);
    try {
      await next;
    } finally {
      if (this.#writeTails.get(hostThreadId) === settled) this.#writeTails.delete(hostThreadId);
    }
  }

  #recordPath(hostThreadId: HostThreadId): string {
    return path.join(this.#threadsDirectory, `${hostThreadId}.json`);
  }

  #delegationPath(delegationId: HostThreadId): string {
    return path.join(this.#delegationsDirectory, `${delegationId}.json`);
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
