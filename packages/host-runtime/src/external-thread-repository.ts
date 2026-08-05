import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import {
  MappingStore,
  type CommitReadyThreadInput,
  type CreateProvisionalThreadInput,
  type ReplaceReadySessionAfterLastTurnInput,
  type ReplaceReadySessionInput,
  type StoredThreadRecordV1,
  type StoredTurnMappingV1,
} from "@codexhost/mapping-store";
import { projectHistoricalTurn, type JsonObject } from "@codexhost/protocol-core";
import {
  hostThreadIdSchema,
  hostTurnIdSchema,
  type HostThreadId,
  type NativeCheckpointRef,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

export interface ExternalThreadStore {
  initialize(): Promise<void>;
  getThread(hostThreadId: HostThreadId): Promise<StoredThreadRecordV1 | null>;
  listThreads(): Promise<StoredThreadRecordV1[]>;
  createProvisional(input: CreateProvisionalThreadInput): Promise<StoredThreadRecordV1>;
  commitReady(input: CommitReadyThreadInput): Promise<StoredThreadRecordV1>;
  replaceReadySession(input: ReplaceReadySessionInput): Promise<StoredThreadRecordV1>;
  replaceReadySessionAfterLastTurn(
    input: ReplaceReadySessionAfterLastTurnInput,
  ): Promise<StoredThreadRecordV1>;
  upsertTurnMappings(
    hostThreadId: HostThreadId,
    mappings: StoredTurnMappingV1[],
  ): Promise<StoredThreadRecordV1>;
  reconcileTurnMappings(
    hostThreadId: HostThreadId,
    mappings: StoredTurnMappingV1[],
  ): Promise<StoredThreadRecordV1>;
  setTitle(hostThreadId: HostThreadId, title: string): Promise<StoredThreadRecordV1>;
  setTransportModelId(
    hostThreadId: HostThreadId,
    transportModelId: string,
  ): Promise<StoredThreadRecordV1>;
  setArchived(hostThreadId: HostThreadId, archived: boolean): Promise<StoredThreadRecordV1>;
  removeProvisional(hostThreadId: HostThreadId): Promise<void>;
  removeThread(hostThreadId: HostThreadId): Promise<void>;
  close(): Promise<void>;
}

export interface AlignedExternalSnapshot {
  record: StoredThreadRecordV1;
  turns: JsonObject[];
}

function nativeTurnKey(ref: NativeTurnRef): string {
  return `${ref.harnessId}\u0000${ref.nativeSessionId}\u0000${ref.nativeTurnKey}\u0000${ref.formatVersion}`;
}

function sameMapping(left: StoredTurnMappingV1, right: StoredTurnMappingV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function defaultMappingStoreDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR;
  return path.join(
    dataDirectory ? path.resolve(dataDirectory) : path.join(os.homedir(), ".codexhost"),
    "mapping-store",
  );
}

export function createProductionExternalThreadStore(
  environment: NodeJS.ProcessEnv,
): ExternalThreadStore {
  return new MappingStore({ directory: defaultMappingStoreDirectory(environment) });
}

export class ExternalThreadRepository {
  constructor(private readonly store: ExternalThreadStore) {}

  initialize(): Promise<void> {
    return this.store.initialize();
  }

  close(): Promise<void> {
    return this.store.close();
  }

  async find(threadId: string): Promise<StoredThreadRecordV1 | null> {
    const parsed = hostThreadIdSchema.safeParse(threadId);
    return parsed.success ? this.store.getThread(parsed.data) : null;
  }

  list(): Promise<StoredThreadRecordV1[]> {
    return this.store.listThreads();
  }

  createProvisional(input: CreateProvisionalThreadInput): Promise<StoredThreadRecordV1> {
    return this.store.createProvisional(input);
  }

  commitNative(
    hostThreadId: HostThreadId,
    nativeSessionRef: NativeSessionRef,
    turnMappings: StoredTurnMappingV1[] = [],
  ): Promise<StoredThreadRecordV1> {
    return this.store.commitReady({ hostThreadId, nativeSessionRef, turnMappings });
  }

  setTitle(hostThreadId: HostThreadId, title: string): Promise<StoredThreadRecordV1> {
    return this.store.setTitle(hostThreadId, title);
  }

  setTransportModelId(
    hostThreadId: HostThreadId,
    transportModelId: string,
  ): Promise<StoredThreadRecordV1> {
    return this.store.setTransportModelId(hostThreadId, transportModelId);
  }

  setArchived(hostThreadId: HostThreadId, archived: boolean): Promise<StoredThreadRecordV1> {
    return this.store.setArchived(hostThreadId, archived);
  }

  removeProvisional(hostThreadId: HostThreadId): Promise<void> {
    return this.store.removeProvisional(hostThreadId);
  }

  removeThread(hostThreadId: HostThreadId): Promise<void> {
    return this.store.removeThread(hostThreadId);
  }

  async persistTurn(
    record: StoredThreadRecordV1,
    hostTurnId: StoredTurnMappingV1["hostTurnId"],
    nativeTurnRef: NativeTurnRef,
    nativeCheckpointRef?: NativeCheckpointRef,
  ): Promise<StoredThreadRecordV1> {
    if (
      record.state !== "ready" ||
      !record.nativeSessionRef ||
      nativeTurnRef.harnessId !== record.harnessId ||
      nativeTurnRef.nativeSessionId !== record.nativeSessionRef.nativeSessionId ||
      (nativeCheckpointRef &&
        (nativeCheckpointRef.harnessId !== record.harnessId ||
          nativeCheckpointRef.nativeSessionId !== record.nativeSessionRef.nativeSessionId))
    ) {
      throw new Error("Live Turn identity does not belong to the stored Thread");
    }
    return this.store.upsertTurnMappings(record.hostThreadId, [
      {
        hostTurnId,
        nativeTurnRef,
        ...(nativeCheckpointRef ? { nativeCheckpointRef } : {}),
      },
    ]);
  }

  async commitDerivedSnapshot(
    record: StoredThreadRecordV1,
    nativeSessionRef: NativeSessionRef,
    snapshot: HostThreadSnapshot,
  ): Promise<AlignedExternalSnapshot> {
    if (record.state !== "creating" || record.turnMappings.length !== 0) {
      throw new Error("Derived Thread must be provisional before Snapshot commit");
    }
    const mappings = snapshot.turns.map((turn): StoredTurnMappingV1 => {
      if (
        turn.nativeTurnRef.harnessId !== record.harnessId ||
        turn.nativeTurnRef.nativeSessionId !== nativeSessionRef.nativeSessionId ||
        (turn.checkpoint &&
          (turn.checkpoint.harnessId !== record.harnessId ||
            turn.checkpoint.nativeSessionId !== nativeSessionRef.nativeSessionId))
      ) {
        throw new Error("Derived Snapshot identity does not belong to its Native Session");
      }
      return {
        hostTurnId: hostTurnIdSchema.parse(randomUUID()),
        nativeTurnRef: turn.nativeTurnRef,
        ...(turn.checkpoint ? { nativeCheckpointRef: turn.checkpoint } : {}),
      };
    });
    const nextRecord = await this.store.commitReady({
      hostThreadId: record.hostThreadId,
      nativeSessionRef,
      turnMappings: mappings,
    });
    return {
      record: nextRecord,
      turns: snapshot.turns.map((turn, index) => {
        const mapping = mappings[index];
        if (!mapping) throw new Error("Derived Snapshot mapping is incomplete");
        return projectHistoricalTurn({
          turnId: mapping.hostTurnId,
          cwd: record.cwd,
          snapshot: turn,
        });
      }),
    };
  }

  async commitForkRollback(
    derived: StoredThreadRecordV1,
    source: StoredThreadRecordV1,
    nativeSessionRef: NativeSessionRef,
    snapshot: HostThreadSnapshot,
  ): Promise<AlignedExternalSnapshot> {
    if (
      derived.state !== "ready" ||
      !derived.nativeSessionRef ||
      source.state !== "ready" ||
      !source.nativeSessionRef ||
      !derived.forkSource ||
      derived.forkSource.hostThreadId !== source.hostThreadId ||
      derived.harnessId !== source.harnessId
    ) {
      throw new Error("External rollback lineage is not a ready source prefix");
    }
    const sourceBoundaryIndex = source.turnMappings.findIndex(
      ({ hostTurnId }) => hostTurnId === derived.forkSource?.hostTurnId,
    );
    const retainedCount = snapshot.turns.length;
    if (
      sourceBoundaryIndex < 0 ||
      derived.turnMappings.length !== sourceBoundaryIndex + 1 ||
      retainedCount < 1 ||
      retainedCount >= derived.turnMappings.length
    ) {
      throw new Error("External rollback does not retain an exact shorter source prefix");
    }
    const selectedSource = source.turnMappings[retainedCount - 1];
    if (!selectedSource?.nativeCheckpointRef) {
      throw new Error("External rollback source Checkpoint is unavailable");
    }
    if (
      nativeSessionRef.harnessId !== derived.harnessId ||
      nativeSessionRef.nativeSessionId === derived.nativeSessionRef.nativeSessionId ||
      nativeSessionRef.nativeSessionId === source.nativeSessionRef.nativeSessionId
    ) {
      throw new Error("External rollback did not create a distinct Native Session");
    }

    const mappings = snapshot.turns.map((turn, index): StoredTurnMappingV1 => {
      const previous = derived.turnMappings[index];
      if (
        !previous ||
        turn.nativeTurnRef.harnessId !== derived.harnessId ||
        turn.nativeTurnRef.nativeSessionId !== nativeSessionRef.nativeSessionId ||
        (turn.checkpoint &&
          (turn.checkpoint.harnessId !== derived.harnessId ||
            turn.checkpoint.nativeSessionId !== nativeSessionRef.nativeSessionId))
      ) {
        throw new Error("External rollback Snapshot identity is invalid");
      }
      return {
        hostTurnId: previous.hostTurnId,
        nativeTurnRef: turn.nativeTurnRef,
        ...(turn.checkpoint ? { nativeCheckpointRef: turn.checkpoint } : {}),
      };
    });
    const nextRecord = await this.store.replaceReadySession({
      hostThreadId: derived.hostThreadId,
      nativeSessionRef,
      turnMappings: mappings,
      forkSource: {
        hostThreadId: source.hostThreadId,
        hostTurnId: selectedSource.hostTurnId,
      },
    });
    return {
      record: nextRecord,
      turns: snapshot.turns.map((turn, index) => {
        const mapping = mappings[index];
        if (!mapping) throw new Error("External rollback Snapshot mapping is incomplete");
        return projectHistoricalTurn({
          turnId: mapping.hostTurnId,
          cwd: derived.cwd,
          snapshot: turn,
        });
      }),
    };
  }

  async commitLastTurnRollback(
    current: StoredThreadRecordV1,
    nativeSessionRef: NativeSessionRef,
    snapshot: HostThreadSnapshot,
  ): Promise<AlignedExternalSnapshot> {
    if (
      current.state !== "ready" ||
      !current.nativeSessionRef ||
      nativeSessionRef.harnessId !== current.harnessId ||
      nativeSessionRef.nativeSessionId === current.nativeSessionRef.nativeSessionId ||
      snapshot.turns.length !== current.turnMappings.length - 1
    ) {
      throw new Error("Last-Turn rollback is not an exact ready Session replacement");
    }
    const mappings = snapshot.turns.map((turn, index): StoredTurnMappingV1 => {
      const previous = current.turnMappings[index];
      if (
        !previous ||
        turn.nativeTurnRef.harnessId !== current.harnessId ||
        turn.nativeTurnRef.nativeSessionId !== nativeSessionRef.nativeSessionId ||
        (turn.checkpoint &&
          (turn.checkpoint.harnessId !== current.harnessId ||
            turn.checkpoint.nativeSessionId !== nativeSessionRef.nativeSessionId))
      ) {
        throw new Error("Last-Turn rollback Snapshot identity is invalid");
      }
      return {
        hostTurnId: previous.hostTurnId,
        nativeTurnRef: turn.nativeTurnRef,
        ...(turn.checkpoint ? { nativeCheckpointRef: turn.checkpoint } : {}),
      };
    });
    const nextRecord = await this.store.replaceReadySessionAfterLastTurn({
      hostThreadId: current.hostThreadId,
      nativeSessionRef,
      turnMappings: mappings,
    });
    return {
      record: nextRecord,
      turns: snapshot.turns.map((turn, index) => {
        const mapping = mappings[index];
        if (!mapping) throw new Error("Last-Turn rollback Snapshot mapping is incomplete");
        return projectHistoricalTurn({
          turnId: mapping.hostTurnId,
          cwd: current.cwd,
          snapshot: turn,
        });
      }),
    };
  }

  async sessionTreeId(record: StoredThreadRecordV1): Promise<string> {
    let current = record;
    const visited = new Set<string>();
    while (current.forkSource) {
      if (visited.has(current.hostThreadId))
        throw new Error("External Thread Fork tree contains a cycle");
      visited.add(current.hostThreadId);
      const source = await this.find(current.forkSource.hostThreadId);
      if (!source) break;
      current = source;
    }
    return current.hostThreadId;
  }

  async alignSnapshot(
    record: StoredThreadRecordV1,
    snapshot: HostThreadSnapshot,
  ): Promise<AlignedExternalSnapshot> {
    const nativeSessionRef = record.nativeSessionRef;
    if (!nativeSessionRef || record.state !== "ready") {
      throw new Error("External Thread has no committed Native Session identity");
    }
    for (const turn of snapshot.turns) {
      if (
        turn.nativeTurnRef.harnessId !== record.harnessId ||
        turn.nativeTurnRef.nativeSessionId !== nativeSessionRef.nativeSessionId ||
        (turn.checkpoint &&
          (turn.checkpoint.harnessId !== record.harnessId ||
            turn.checkpoint.nativeSessionId !== nativeSessionRef.nativeSessionId))
      ) {
        throw new Error("External Snapshot identity does not belong to the stored Thread");
      }
    }

    const mappingsByNative = new Map(
      record.turnMappings.map(
        (mapping) => [nativeTurnKey(mapping.nativeTurnRef), mapping] as const,
      ),
    );
    const aligned = snapshot.turns.map((turn) => {
      const existing = mappingsByNative.get(nativeTurnKey(turn.nativeTurnRef));
      const mapping =
        existing ??
        ({
          hostTurnId: hostTurnIdSchema.parse(randomUUID()),
          nativeTurnRef: turn.nativeTurnRef,
          ...(turn.checkpoint ? { nativeCheckpointRef: turn.checkpoint } : {}),
        } satisfies StoredTurnMappingV1);
      return {
        existing,
        snapshot: turn,
        mapping: {
          ...mapping,
          ...(turn.checkpoint ? { nativeCheckpointRef: turn.checkpoint } : {}),
        },
      };
    });
    let existingIndex = 0;
    for (const { existing } of aligned) {
      if (!existing) continue;
      if (existing.hostTurnId !== record.turnMappings[existingIndex]?.hostTurnId) {
        throw new Error("Persisted Turn mappings do not match the Native Snapshot order");
      }
      existingIndex += 1;
    }
    if (existingIndex !== record.turnMappings.length) {
      throw new Error("Persisted Turn mappings do not match the Native Snapshot order");
    }

    const orderedMappings = aligned.map(({ mapping }) => mapping);
    const mappingsChanged =
      orderedMappings.length !== record.turnMappings.length ||
      orderedMappings.some((mapping, index) => {
        const persisted = record.turnMappings[index];
        return !persisted || !sameMapping(mapping, persisted);
      });
    const nextRecord = mappingsChanged
      ? await this.store.reconcileTurnMappings(record.hostThreadId, orderedMappings)
      : record;
    return {
      record: nextRecord,
      turns: aligned.map(({ mapping, snapshot: turn }) =>
        projectHistoricalTurn({ turnId: mapping.hostTurnId, cwd: record.cwd, snapshot: turn }),
      ),
    };
  }
}

export function createExternalThreadRecordInput(input: {
  hostThreadId?: HostThreadId;
  harnessId: CreateProvisionalThreadInput["harnessId"];
  cwd: string;
  title?: string;
  transportModelId: string;
  ephemeral: boolean;
  historyMode: "legacy" | "paginated";
  forkSource?: CreateProvisionalThreadInput["forkSource"];
}): CreateProvisionalThreadInput {
  return {
    hostThreadId: input.hostThreadId ?? hostThreadIdSchema.parse(randomUUID()),
    createRequestId: randomUUID(),
    harnessId: input.harnessId,
    cwd: input.cwd,
    ...(input.title ? { title: input.title } : {}),
    transportModelId: input.transportModelId,
    ephemeral: input.ephemeral,
    historyMode: input.historyMode,
    ...(input.forkSource ? { forkSource: input.forkSource } : {}),
  };
}

export function externalThreadValue(input: {
  record: StoredThreadRecordV1;
  turns: JsonObject[];
  sessionId: string;
  running?: boolean;
  loaded?: boolean;
}): JsonObject {
  const { record } = input;
  const createdAt = Math.floor(Date.parse(record.createdAt) / 1_000);
  const updatedAt = Math.floor(Date.parse(record.updatedAt) / 1_000);
  const preview = input.turns
    .flatMap((turn) => (Array.isArray(turn.items) ? turn.items : []))
    .find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        item.type === "userMessage",
    );
  const previewContent =
    typeof preview === "object" && preview !== null && !Array.isArray(preview)
      ? preview.content
      : null;
  const previewText = Array.isArray(previewContent)
    ? previewContent
        .filter(
          (part): part is JsonObject =>
            typeof part === "object" &&
            part !== null &&
            !Array.isArray(part) &&
            part.type === "text",
        )
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("\n")
    : "";
  return {
    id: record.hostThreadId,
    sessionId: input.sessionId,
    path: null,
    cwd: record.cwd,
    source: "vscode",
    threadSource: null,
    modelProvider: "codexhost",
    cliVersion: "codexhost",
    createdAt,
    updatedAt,
    recencyAt: updatedAt,
    status:
      input.loaded === false
        ? { type: "notLoaded" }
        : input.running
          ? { type: "active", activeFlags: [] }
          : { type: "idle" },
    turns: input.turns,
    preview: previewText,
    name: record.title || null,
    gitInfo: null,
    forkedFromId: record.forkSource?.hostThreadId ?? null,
    parentThreadId: null,
    ephemeral: record.ephemeral,
    canAcceptDirectInput: input.loaded === false ? null : true,
    historyMode: record.historyMode,
    isPinned: false,
    agentNickname: null,
    agentRole: null,
    extra: null,
  };
}
