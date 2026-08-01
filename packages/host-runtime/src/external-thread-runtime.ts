import type {
  HarnessAdapter,
  HarnessModelRef,
  HarnessSession,
  TurnCompletedEvent,
} from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  mapExternalThreadHarnessError,
  type CodexTurnProjector,
  type ExternalHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import type { HostInteractionId, HostTurnId, NativeSessionRef } from "@codexhost/shared-contracts";

import {
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import { SessionStateObserver } from "./session-state-observer.js";

export interface TurnProjectionGate {
  promise: Promise<void>;
  resolve(): void;
}

export interface ExternalThread {
  id: StoredThreadRecordV1["hostThreadId"];
  cwd: string;
  harnessId: ExternalHarnessId;
  session: HarnessSession;
  outputTask: Promise<void>;
  requestedModel?: HarnessModelRef;
  record: StoredThreadRecordV1;
  sessionId: string;
  stateObserver: SessionStateObserver;
  thread: JsonObject;
  transportModelId: string;
  turns: JsonObject[];
  historyHydrated: boolean;
  running: boolean;
  activeTurnId: HostTurnId | null;
  projectedTurns: Map<HostTurnId, { projector: CodexTurnProjector }>;
  responseGates: Map<HostTurnId, TurnProjectionGate>;
  persistenceError: Error | null;
  ignoredInteractionIds: Set<HostInteractionId>;
}

export type ExternalThreadLocation =
  | { kind: "official" }
  | {
      kind: "external";
      record: StoredThreadRecordV1;
      thread: ExternalThread | null;
    }
  | { kind: "error"; error: ExternalThreadRpcError };

export type ExternalThreadResolution =
  | { kind: "official" }
  | { kind: "external"; thread: ExternalThread; historyFresh: boolean }
  | { kind: "error"; error: ExternalThreadRpcError };

class ExternalThreadOpenError extends Error {
  constructor(readonly rpcError: ExternalThreadRpcError) {
    super(rpcError.message);
    this.name = "ExternalThreadOpenError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExternalThreadRuntime {
  readonly #adapters: Map<ExternalHarnessId, HarnessAdapter>;
  readonly #consumeOutputs: (thread: ExternalThread) => Promise<void>;
  readonly #diagnose: (error: unknown) => void;
  readonly #repository: ExternalThreadRepository;
  readonly #restores = new Map<string, Promise<ExternalThread>>();
  readonly #threads = new Map<string, ExternalThread>();

  constructor(input: {
    adapters: Map<ExternalHarnessId, HarnessAdapter>;
    repository: ExternalThreadRepository;
    consumeOutputs(thread: ExternalThread): Promise<void>;
    diagnose(error: unknown): void;
  }) {
    this.#adapters = input.adapters;
    this.#repository = input.repository;
    this.#consumeOutputs = input.consumeOutputs;
    this.#diagnose = input.diagnose;
  }

  get(threadId: string): ExternalThread | undefined {
    return this.#threads.get(threadId);
  }

  values(): ExternalThread[] {
    return [...this.#threads.values()];
  }

  remove(threadId: string): void {
    this.#threads.delete(threadId);
  }

  clear(): void {
    this.#threads.clear();
    this.#restores.clear();
  }

  register(input: {
    record: StoredThreadRecordV1;
    session: HarnessSession;
    sessionId: string;
    thread: JsonObject;
    turns: JsonObject[];
    requestedModel?: HarnessModelRef;
  }): ExternalThread {
    const harnessId = input.record.harnessId as ExternalHarnessId;
    if (!this.#adapters.has(harnessId)) {
      throw new Error(`External Harness '${input.record.harnessId}' is not registered`);
    }
    const effectiveModel = input.requestedModel ?? input.session.initialState.effectiveModel;
    const externalThread: ExternalThread = {
      id: input.record.hostThreadId,
      cwd: input.record.cwd,
      harnessId,
      session: input.session,
      outputTask: Promise.resolve(),
      ...(effectiveModel ? { requestedModel: effectiveModel } : {}),
      record: input.record,
      sessionId: input.sessionId,
      stateObserver: new SessionStateObserver(input.session.initialState),
      thread: input.thread,
      transportModelId: input.record.transportModelId,
      turns: input.turns,
      historyHydrated: true,
      running: false,
      activeTurnId: null,
      projectedTurns: new Map(),
      responseGates: new Map(),
      persistenceError: null,
      ignoredInteractionIds: new Set(),
    };
    externalThread.outputTask = this.#consumeOutputs(externalThread);
    this.#threads.set(externalThread.id, externalThread);
    return externalThread;
  }

  async replace(
    current: ExternalThread,
    input: {
      record: StoredThreadRecordV1;
      session: HarnessSession;
      sessionId: string;
      thread: JsonObject;
      turns: JsonObject[];
    },
  ): Promise<ExternalThread> {
    if (
      current.running ||
      this.#threads.get(current.id) !== current ||
      input.record.hostThreadId !== current.id
    ) {
      throw new Error("External Thread runtime cannot replace an active or stale Session");
    }
    try {
      await current.session.close();
      await current.outputTask;
    } catch (error) {
      this.#diagnose(error);
    }
    this.#threads.delete(current.id);
    return this.register(input);
  }

  async locate(threadId: string): Promise<ExternalThreadLocation> {
    const loaded = this.#threads.get(threadId);
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
      const restored = this.#threads.get(threadId);
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

  async refresh(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
    const snapshot = await thread.session.readSnapshot();
    if (!snapshot.ok) return mapExternalThreadHarnessError(snapshot.error, "read");
    try {
      const aligned = await this.#repository.alignSnapshot(thread.record, snapshot.value);
      thread.record = aligned.record;
      thread.turns = aligned.turns;
      thread.historyHydrated = true;
      thread.thread = externalThreadValue({
        record: aligned.record,
        turns: aligned.turns,
        sessionId: thread.sessionId,
        running: thread.running,
      });
      return null;
    } catch {
      return { code: -32081, message: "External Thread history could not be persisted" };
    }
  }

  async persistTerminalIdentity(
    thread: ExternalThread,
    event: TurnCompletedEvent,
  ): Promise<Error | null> {
    if (thread.persistenceError) return thread.persistenceError;
    if (!event.nativeTurnRef) {
      return event.outcome.status === "succeeded"
        ? new Error("Successful external Turn has no Native Turn identity")
        : null;
    }
    try {
      thread.record = await this.#repository.persistTurn(
        thread.record,
        event.turnId,
        event.nativeTurnRef,
        event.outcome.checkpoint,
      );
      return null;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(errorMessage(error));
      thread.persistenceError = failure;
      thread.stateObserver.fault(failure);
      this.#diagnose("External Turn identity could not be persisted");
      return failure;
    }
  }

  async #restore(record: StoredThreadRecordV1): Promise<ExternalThread> {
    const harnessId = record.harnessId as ExternalHarnessId;
    const adapter = this.#adapters.get(harnessId);
    if (!adapter || !record.nativeSessionRef) {
      throw new ExternalThreadOpenError({
        code: -32077,
        message: "External Harness is unavailable",
      });
    }
    const opened = await adapter.open({
      kind: "resume",
      cwd: record.cwd,
      nativeRef: record.nativeSessionRef as NativeSessionRef,
    });
    if (!opened.ok) {
      throw new ExternalThreadOpenError(mapExternalThreadHarnessError(opened.error, "resume"));
    }
    const session = opened.value;
    try {
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) {
        throw new ExternalThreadOpenError(mapExternalThreadHarnessError(snapshot.error, "read"));
      }
      const aligned = await this.#repository.alignSnapshot(record, snapshot.value);
      const sessionId = await this.#repository.sessionTreeId(aligned.record);
      return this.register({
        record: aligned.record,
        session,
        sessionId,
        thread: externalThreadValue({
          record: aligned.record,
          turns: aligned.turns,
          sessionId,
        }),
        turns: aligned.turns,
      });
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }
}
