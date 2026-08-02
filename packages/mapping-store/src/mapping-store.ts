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
  storedThreadRecordV1Schema,
  type CommitReadyThreadInput,
  type CreateProvisionalThreadInput,
  type ReplaceReadySessionInput,
  type StoredThreadRecordV1,
  type StoredTurnMappingV1,
} from "./records.js";

export type MappingStoreErrorCode =
  | "STORE_LOCKED"
  | "STORE_NOT_INITIALIZED"
  | "THREAD_NOT_FOUND"
  | "DUPLICATE_THREAD_ID"
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
}

function cloneRecord(record: StoredThreadRecordV1): StoredThreadRecordV1 {
  return JSON.parse(JSON.stringify(record)) as StoredThreadRecordV1;
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return systemErrorCode(error) === "EPERM";
  }
}

export class MappingStore {
  readonly #backupsDirectory: string;
  readonly #beforeReplace: MappingStoreOptions["beforeReplace"];
  readonly #directory: string;
  readonly #instanceId: string;
  readonly #lockPath: string;
  readonly #now: () => Date;
  readonly #quarantineDirectory: string;
  readonly #threadsDirectory: string;
  readonly #records = new Map<HostThreadId, StoredThreadRecordV1>();
  readonly #createRequests = new Map<string, HostThreadId>();
  readonly #nativeSessions = new Map<string, HostThreadId>();
  readonly #hostTurns = new Map<HostTurnId, HostThreadId>();
  readonly #nativeTurns = new Map<string, HostTurnId>();
  readonly #writeTails = new Map<HostThreadId, Promise<void>>();
  #initialized = false;
  #lockHandle: FileHandle | null = null;

  constructor(options: MappingStoreOptions) {
    this.#directory = path.resolve(options.directory);
    this.#threadsDirectory = path.join(this.#directory, "threads");
    this.#backupsDirectory = path.join(this.#directory, "backups");
    this.#quarantineDirectory = path.join(this.#directory, "quarantine");
    this.#lockPath = path.join(this.#directory, "store.lock");
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
    this.#beforeReplace = options.beforeReplace;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await Promise.all([
      mkdir(this.#threadsDirectory, { recursive: true }),
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

  async findThreadByTurn(hostTurnId: HostTurnId): Promise<StoredThreadRecordV1 | null> {
    this.#requireInitialized();
    const threadId = this.#hostTurns.get(hostTurnId);
    return threadId ? this.getThread(threadId) : null;
  }

  async createProvisional(input: CreateProvisionalThreadInput): Promise<StoredThreadRecordV1> {
    this.#requireInitialized();
    if (this.#records.has(input.hostThreadId)) {
      throw new MappingStoreError("DUPLICATE_THREAD_ID", "Host Thread ID already exists");
    }
    if (this.#createRequests.has(input.createRequestId)) {
      throw new MappingStoreError(
        "DUPLICATE_CREATE_REQUEST",
        "Create request already identifies another Thread",
      );
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
      turnMappings: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }) as StoredThreadRecordV1;
    await this.#writeNew(record);
    return cloneRecord(record);
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

  async upsertTurnMappings(
    hostThreadId: HostThreadId,
    mappings: StoredTurnMappingV1[],
  ): Promise<StoredThreadRecordV1> {
    return this.#update(hostThreadId, (current) => ({
      ...current,
      turnMappings: this.#mergeMappings(current.turnMappings, mappings),
    }));
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
    const names = await readdir(this.#threadsDirectory);
    await Promise.all(
      names
        .filter((name) => name.includes(".tmp-"))
        .map((name) => rm(path.join(this.#threadsDirectory, name), { force: true })),
    );
  }

  async #acquireLock(): Promise<void> {
    const attempt = async (): Promise<FileHandle> => {
      const handle = await open(this.#lockPath, "wx", constants.S_IRUSR | constants.S_IWUSR);
      const lock: LockRecord = {
        pid: process.pid,
        instanceId: this.#instanceId,
        startedAt: this.#now().toISOString(),
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
    if (typeof existing.pid === "number" && processAlive(existing.pid)) {
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
    if (record.nativeSessionRef) {
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
    this.#nativeSessions.clear();
    this.#hostTurns.clear();
    this.#nativeTurns.clear();
    for (const record of this.#records.values()) {
      this.#validateGlobal(record, record.hostThreadId);
      this.#createRequests.set(record.createRequestId, record.hostThreadId);
      if (record.nativeSessionRef) {
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

  #backupPath(hostThreadId: HostThreadId): string {
    return path.join(this.#backupsDirectory, `${hostThreadId}.json`);
  }

  #requireInitialized(): void {
    if (!this.#initialized) {
      throw new MappingStoreError("STORE_NOT_INITIALIZED", "Mapping Store is not initialized");
    }
  }
}
