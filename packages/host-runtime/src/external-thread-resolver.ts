import {
  HarnessOutputChannel,
  type HarnessAdapter,
  type HarnessResult,
  type HarnessSession,
  type HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  mapExternalThreadHarnessError,
  type ExternalConfigurationSelection,
  type ExternalHarnessId,
} from "@codexhost/protocol-core";
import {
  permissionModeFixedAtCreate,
  type HarnessId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { DELEGATION_THREAD_ID_ENV } from "./delegation-types.js";
import {
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import type {
  ExternalThread,
  ExternalThreadLocation,
  ExternalThreadRegistration,
  ExternalThreadResolution,
} from "./external-thread-runtime.js";

function nativeTurnKey(turn: HostThreadSnapshot["turns"][number]): string {
  const ref = turn.nativeTurnRef;
  return `${ref.harnessId}\u0000${ref.nativeSessionId}\u0000${ref.nativeTurnKey}\u0000${ref.formatVersion}`;
}

function mergeReadonlySnapshot(
  previous: HostThreadSnapshot,
  next: HostThreadSnapshot,
): HostThreadSnapshot {
  const nextByTurn = new Map(next.turns.map((turn) => [nativeTurnKey(turn), turn] as const));
  const retainedKeys = new Set<string>();
  const turns = previous.turns.map((turn) => {
    const key = nativeTurnKey(turn);
    retainedKeys.add(key);
    const update = nextByTurn.get(key);
    if (!update) return turn;
    const itemsById = new Map(update.items.map((item) => [item.item.itemId, item] as const));
    const retainedItemIds = new Set<string>();
    const items = turn.items.map((item) => {
      retainedItemIds.add(item.item.itemId);
      return itemsById.get(item.item.itemId) ?? item;
    });
    for (const item of update.items) {
      if (!retainedItemIds.has(item.item.itemId)) items.push(item);
    }
    return {
      ...turn,
      ...update,
      input: update.input.length > 0 ? update.input : turn.input,
      items,
      ...((update.checkpoint ?? turn.checkpoint)
        ? { checkpoint: update.checkpoint ?? turn.checkpoint }
        : {}),
      ...((update.model ?? turn.model) ? { model: update.model ?? turn.model } : {}),
    };
  });
  for (const turn of next.turns) {
    if (!retainedKeys.has(nativeTurnKey(turn))) turns.push(turn);
  }
  return {
    turns,
    ...((next.state ?? previous.state) ? { state: next.state ?? previous.state } : {}),
  };
}

class ReadonlySnapshotSession implements HarnessSession {
  readonly capabilities = {
    configuration: {
      selectModel: false,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "live" as const,
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    subagents: { observe: false, readTranscript: false },
  };
  readonly initialState;
  readonly initialUsage = null;
  readonly outputs: AsyncIterable<never>;
  readonly #channel = new HarnessOutputChannel<never>();
  readonly #readSnapshot: () => Promise<HarnessResult<HostThreadSnapshot>>;
  #lastSnapshot: HostThreadSnapshot;

  constructor(
    readonly harnessId: HarnessId,
    nativeRef: NativeSessionRef,
    initialSnapshot: HostThreadSnapshot,
    readSnapshot: () => Promise<HarnessResult<HostThreadSnapshot>>,
  ) {
    this.initialState = { nativeRef };
    this.#lastSnapshot = initialSnapshot;
    this.#readSnapshot = readSnapshot;
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    const result = await this.#readSnapshot();
    if (!result.ok) return result;
    this.#lastSnapshot = mergeReadonlySnapshot(this.#lastSnapshot, result.value);
    return { ok: true, value: this.#lastSnapshot };
  }

  async execute(): Promise<never> {
    throw new Error("Readonly Subagent Thread cannot execute commands");
  }

  async close(): Promise<void> {
    this.#channel.end();
  }
}

class ExternalThreadOpenError extends Error {
  constructor(readonly rpcError: Extract<ExternalThreadResolution, { kind: "error" }>["error"]) {
    super(rpcError.message);
    this.name = "ExternalThreadOpenError";
  }
}

export class ExternalThreadResolver {
  readonly #diagnose: (error: unknown) => void;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #lookupAdapter: (harnessId: ExternalHarnessId) => HarnessAdapter | undefined;
  readonly #lookupLoaded: (threadId: string) => ExternalThread | undefined;
  readonly #register: (input: ExternalThreadRegistration) => ExternalThread;
  readonly #repository: ExternalThreadRepository;
  readonly #restores = new Map<string, Promise<ExternalThread>>();

  constructor(input: {
    diagnose(error: unknown): void;
    environment: NodeJS.ProcessEnv;
    lookupAdapter(harnessId: ExternalHarnessId): HarnessAdapter | undefined;
    lookupLoaded(threadId: string): ExternalThread | undefined;
    register(registration: ExternalThreadRegistration): ExternalThread;
    repository: ExternalThreadRepository;
  }) {
    this.#diagnose = input.diagnose;
    this.#environment = input.environment;
    this.#lookupAdapter = input.lookupAdapter;
    this.#lookupLoaded = input.lookupLoaded;
    this.#register = input.register;
    this.#repository = input.repository;
  }

  clearPending(): void {
    this.#restores.clear();
  }

  async locate(threadId: string): Promise<ExternalThreadLocation> {
    const loaded = this.#lookupLoaded(threadId);
    if (loaded) return { kind: "external", record: loaded.record, thread: loaded };
    let record: StoredThreadRecordV1 | null;
    try {
      record = await this.#repository.find(threadId);
    } catch {
      return {
        kind: "error",
        error: { code: -32081, message: "External Thread ownership could not be read" },
      };
    }
    if (!record) return { kind: "official" };
    if (record.state !== "ready" || !record.nativeSessionRef) {
      return {
        kind: "error",
        error: { code: -32079, message: "External Native Session is unavailable" },
      };
    }
    return { kind: "external", record, thread: null };
  }

  async resolve(threadId: string): Promise<ExternalThreadResolution> {
    const location = await this.locate(threadId);
    if (location.kind !== "external") return location;
    if (location.thread) {
      return { kind: "external", thread: location.thread, historyFresh: false };
    }
    const { record } = location;
    let restoring = this.#restores.get(threadId);
    if (!restoring) {
      const restored = this.#lookupLoaded(threadId);
      if (restored) return { kind: "external", thread: restored, historyFresh: false };
      restoring = this.#restore(record).finally(() => {
        this.#restores.delete(threadId);
      });
      this.#restores.set(threadId, restoring);
    }
    try {
      return { kind: "external", thread: await restoring, historyFresh: true };
    } catch (error) {
      return {
        kind: "error",
        error:
          error instanceof ExternalThreadOpenError
            ? error.rpcError
            : { code: -32076, message: "External Thread recovery failed" },
      };
    }
  }

  async #restore(record: StoredThreadRecordV1): Promise<ExternalThread> {
    const harnessId = record.harnessId as ExternalHarnessId;
    const adapter = this.#lookupAdapter(harnessId);
    if (!adapter || !record.nativeSessionRef) {
      throw new ExternalThreadOpenError({
        code: -32077,
        message: "External Harness is unavailable",
      });
    }
    if (record.subagent) {
      const subagents = adapter.subagents;
      if (!subagents) {
        throw new ExternalThreadOpenError({
          code: -32077,
          message: "External Harness Subagent history is unavailable",
        });
      }
      const subagent = record.subagent;
      const parent = record.nativeSessionRef as NativeSessionRef;
      const snapshot = await subagents.readSnapshot({
        parent,
        nativeSubagentId: subagent.nativeSubagentId,
        cwd: record.cwd,
      });
      if (!snapshot.ok) {
        throw new ExternalThreadOpenError(mapExternalThreadHarnessError(snapshot.error, "read"));
      }
      const session = new ReadonlySnapshotSession(
        record.harnessId,
        record.nativeSessionRef as NativeSessionRef,
        snapshot.value,
        () =>
          subagents.readSnapshot({
            parent,
            nativeSubagentId: subagent.nativeSubagentId,
            cwd: record.cwd,
          }),
      );
      const aligned = await this.#repository.alignSnapshot(record, snapshot.value);
      const sessionId = await this.#repository.sessionTreeId(aligned.record);
      return this.#register({
        record: aligned.record,
        session,
        sessionId,
        thread: externalThreadValue({ record: aligned.record, turns: aligned.turns, sessionId }),
        turns: aligned.turns,
        ...(snapshot.value.state ? { restoredState: snapshot.value.state } : {}),
      });
    }
    const restoredSelection = decodeExternalTransportSelection(harnessId, record.transportModelId);
    const opened = await adapter.open({
      kind: "resume",
      cwd: record.cwd,
      environment: { ...this.#environment, [DELEGATION_THREAD_ID_ENV]: record.hostThreadId },
      nativeRef: record.nativeSessionRef as NativeSessionRef,
      knownTurnRefs: record.turnMappings.map(({ nativeTurnRef }) => nativeTurnRef),
      ...(harnessId === "grok" && restoredSelection?.permissionModeId
        ? { permissionModeId: restoredSelection.permissionModeId }
        : {}),
    });
    if (!opened.ok) {
      throw new ExternalThreadOpenError(mapExternalThreadHarnessError(opened.error, "resume"));
    }
    const session = opened.value;
    try {
      if (
        restoredSelection?.permissionModeId &&
        harnessId !== "opencode" &&
        !permissionModeFixedAtCreate(session.capabilities.configuration)
      ) {
        if (!session.capabilities.configuration.selectPermissionMode) {
          throw new ExternalThreadOpenError({
            code: -32076,
            message: "External Harness does not support restored Permission Mode selection",
          });
        }
        const selected = await session.execute({
          type: "permissionMode.select",
          permissionModeId: restoredSelection.permissionModeId,
        });
        if (!selected.ok) {
          throw new ExternalThreadOpenError(
            mapExternalThreadHarnessError(selected.error, "resume"),
          );
        }
      }
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) {
        throw new ExternalThreadOpenError(mapExternalThreadHarnessError(snapshot.error, "read"));
      }
      let aligned = await this.#repository.alignSnapshot(record, snapshot.value);
      const restoredState = snapshot.value.state;
      const effectiveModel = restoredState
        ? restoredState.effectiveModel
        : restoredSelection?.model;
      const effectiveThinkingOptionId = restoredState
        ? restoredState.effectiveThinkingOptionId
        : restoredSelection?.thinkingOptionId;
      const effectivePermissionModeId = restoredState
        ? restoredState.effectivePermissionModeId
        : restoredSelection?.permissionModeId;
      let transportModelId = aligned.record.transportModelId;
      // OMP can silently replace an unavailable Model during resume, while OpenCode's
      // additive Permission API cannot reliably restore a stale mode. Persist live state so the
      // next restore does not reapply an obsolete transport token.
      if ((harnessId === "omp" || harnessId === "opencode") && effectiveModel) {
        const liveSelection: ExternalConfigurationSelection = {
          model: effectiveModel,
          ...(effectiveThinkingOptionId ? { thinkingOptionId: effectiveThinkingOptionId } : {}),
          ...((harnessId === "omp" || harnessId === "opencode") && effectivePermissionModeId
            ? { permissionModeId: effectivePermissionModeId }
            : {}),
        };
        transportModelId = encodeExternalTransportSelection(harnessId, liveSelection);
        if (transportModelId !== aligned.record.transportModelId) {
          try {
            aligned = {
              ...aligned,
              record: await this.#repository.setTransportModelId(
                aligned.record.hostThreadId,
                transportModelId,
              ),
            };
          } catch (error) {
            this.#diagnose(error);
          }
        }
      }
      const sessionId = await this.#repository.sessionTreeId(aligned.record);
      return this.#register({
        record: aligned.record,
        session,
        sessionId,
        thread: externalThreadValue({
          record: aligned.record,
          turns: aligned.turns,
          sessionId,
        }),
        turns: aligned.turns,
        ...(effectiveModel ? { requestedModel: effectiveModel } : {}),
        ...(effectiveThinkingOptionId
          ? { requestedThinkingOptionId: effectiveThinkingOptionId }
          : {}),
        ...(effectivePermissionModeId
          ? { requestedPermissionModeId: effectivePermissionModeId }
          : {}),
        ...(restoredState ? { restoredState } : {}),
        transportModelId,
      });
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }
}
