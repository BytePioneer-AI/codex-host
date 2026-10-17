import type {
  HarnessAdapter,
  HarnessModelRef,
  HarnessResult,
  HarnessSession,
  HarnessSessionState,
  HostThreadSnapshot,
  HostUsage,
  TurnCompletedEvent,
} from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  mapExternalThreadHarnessError,
  type CodexTurnProjector,
  type ExternalConfigurationSelection,
  type ExternalHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import { HarnessOutputChannel } from "@codexhost/harness-adapter";
import {
  type HarnessId,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import { DELEGATION_THREAD_ID_ENV } from "./delegation-types.js";
import { SessionStateObserver } from "./session-state-observer.js";
import { DesktopRequestQueue } from "./desktop-request-queue.js";
import { ExternalThreadIdleRelease } from "./external-thread-idle-release.js";
import {
  ExternalSessionReleaseError,
  ExternalThreadLifecycle,
} from "./external-thread-lifecycle.js";
import { UsageMeter } from "./usage-metering.js";

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
  requestedThinkingOptionId?: HarnessThinkingOptionId;
  requestedPermissionModeId?: HarnessPermissionModeId;
  record: StoredThreadRecordV1;
  /** Keep a draft's Native identity in memory until the user submits work. */
  unsubmittedPrewarm: boolean;
  sessionId: string;
  stateObserver: SessionStateObserver;
  thread: JsonObject;
  transportModelId: string;
  turns: JsonObject[];
  historyHydrated: boolean;
  running: boolean;
  activeTurnId: HostTurnId | null;
  // Terminal Turn projected by this process that is still the latest Turn
  // attempt; any later start clears it. A read may report it when native
  // history cannot be refreshed.
  projectedTerminalTurnId: HostTurnId | null;
  latestUsage: HostUsage | null;
  /** Host metering for the current Session only; replaced with it. */
  usageMeter: UsageMeter;
  usageTurnId: HostTurnId | null;
  projectedTurns: Map<HostTurnId, { projector: CodexTurnProjector }>;
  responseGates: Map<HostTurnId, TurnProjectionGate>;
  ephemeralTurnIds: Set<HostTurnId>;
  persistenceError: Error | null;
  ignoredInteractionIds: Set<HostInteractionId>;
  /** Text-only context accepted from Codex's thread/inject_items before the next Turn. */
  pendingInjectedText: string[];
  /** Native Session faulted or closed; idle Threads should restore instead of reuse. */
  sessionUnavailable: boolean;
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
  constructor(readonly rpcError: ExternalThreadRpcError) {
    super(rpcError.message);
    this.name = "ExternalThreadOpenError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryError(error: unknown): ExternalThreadRpcError {
  if (error instanceof ExternalThreadOpenError) return error.rpcError;
  if (error instanceof ExternalSessionReleaseError) return { code: -32075, message: error.message };
  return { code: -32076, message: "External Thread recovery failed; retry the request" };
}

export class ExternalThreadRuntime {
  readonly idleRelease: ExternalThreadIdleRelease;
  readonly #adapters: Map<ExternalHarnessId, HarnessAdapter>;
  readonly #consumeOutputs: (thread: ExternalThread) => Promise<void>;
  readonly #diagnose: (error: unknown) => void;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #repository: ExternalThreadRepository;
  readonly #lifecycle = new ExternalThreadLifecycle();
  readonly #hasRunningDescendants: (threadId: string) => boolean;
  readonly #subagentRunning: (threadId: string) => boolean;
  readonly #threads = new Map<string, ExternalThread>();

  constructor(input: {
    adapters: Map<ExternalHarnessId, HarnessAdapter>;
    environment?: NodeJS.ProcessEnv;
    repository: ExternalThreadRepository;
    consumeOutputs(thread: ExternalThread): Promise<void>;
    diagnose(error: unknown): void;
    subagentRunning?(threadId: string): boolean;
    hasRunningDescendants?(threadId: string): boolean;
    idleRelease?: {
      queue: DesktopRequestQueue;
      canRelease(thread: ExternalThread): boolean;
      onClosed?(thread: ExternalThread): Promise<void>;
    };
  }) {
    this.#adapters = input.adapters;
    this.#environment = input.environment ?? process.env;
    this.#repository = input.repository;
    this.#consumeOutputs = input.consumeOutputs;
    this.#diagnose = input.diagnose;
    this.#subagentRunning = input.subagentRunning ?? (() => false);
    this.#hasRunningDescendants = input.hasRunningDescendants ?? (() => false);
    this.idleRelease = new ExternalThreadIdleRelease({
      threads: () => this.values(),
      get: (id) => this.get(id),
      remove: (id) => this.remove(id),
      queue: input.idleRelease?.queue ?? new DesktopRequestQueue(),
      canRelease: (thread) =>
        !thread.sessionUnavailable &&
        !this.#lifecycle.busy(thread.id) &&
        (input.idleRelease?.canRelease(thread) ?? false),
      ...(input.idleRelease?.onClosed ? { onClosed: input.idleRelease.onClosed } : {}),
      diagnose: input.diagnose,
    });
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
  }

  drain(): Promise<void> {
    return this.#lifecycle.drain();
  }

  #withLifecycle<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return this.#lifecycle.run(threadId, async () => {
      // Idle release may already own the Session. New idle releases are excluded by busy().
      await this.idleRelease.waitForClose(threadId);
      return operation();
    });
  }

  markSessionUnavailable(thread: ExternalThread): void {
    thread.sessionUnavailable = true;
  }

  #idleForRestore(thread: ExternalThread): boolean {
    if (thread.running || thread.activeTurnId !== null) return false;
    if (thread.session.hasBackgroundWork?.()) return false;
    if (this.#hasRunningDescendants(thread.id)) return false;
    return true;
  }

  async #dropIdleSession(thread: ExternalThread): Promise<void> {
    if (this.#threads.get(thread.id) !== thread) return;
    thread.sessionUnavailable = true;
    await this.#lifecycle.release(thread.id, thread.session, thread.outputTask);
    if (this.#threads.get(thread.id) !== thread) return;
    await this.#retireSubagents(thread);
    if (this.#threads.get(thread.id) === thread) this.#threads.delete(thread.id);
  }

  /** Called without awaiting from the output consumer: release itself drains that consumer. */
  async discardUnavailableIdle(thread: ExternalThread): Promise<void> {
    const session = thread.session;
    try {
      await this.#withLifecycle(thread.id, async () => {
        // A queued discard must not close a Session revived in place by an earlier operation.
        if (
          this.#threads.get(thread.id) !== thread ||
          thread.session !== session ||
          !thread.sessionUnavailable ||
          !this.#idleForRestore(thread)
        )
          return;
        await this.#dropIdleSession(thread);
      });
    } catch (error) {
      // Preserve the owner and the release blocker; the next request can retry confirmation.
      this.#diagnose(error);
    }
  }

  register(input: {
    record: StoredThreadRecordV1;
    session: HarnessSession;
    sessionId: string;
    thread: JsonObject;
    turns: JsonObject[];
    requestedModel?: HarnessModelRef;
    requestedThinkingOptionId?: HarnessThinkingOptionId;
    requestedPermissionModeId?: HarnessPermissionModeId;
    transportModelId?: string;
    restoredState?: HarnessSessionState;
    unsubmittedPrewarm?: boolean;
  }): ExternalThread {
    const harnessId = input.record.harnessId as ExternalHarnessId;
    if (!this.#adapters.has(harnessId)) {
      throw new Error(`External Harness '${input.record.harnessId}' is not registered`);
    }
    const initialState = input.restoredState ?? input.session.initialState;
    const effectiveModel = input.requestedModel ?? initialState.effectiveModel;
    const effectiveThinkingOptionId =
      input.requestedThinkingOptionId ?? initialState.effectiveThinkingOptionId;
    const effectivePermissionModeId =
      input.requestedPermissionModeId ?? initialState.effectivePermissionModeId;
    const observerState: HarnessSessionState = {
      ...initialState,
      ...(effectiveModel ? { effectiveModel } : {}),
      ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
      ...(effectivePermissionModeId ? { effectivePermissionModeId } : {}),
    };
    // A Subagent Thread can be opened while its Subagent is still running. Its
    // live status lives in the Host, not in the stored record, so seed it here
    // instead of publishing a Thread that claims to be idle.
    const running = this.#subagentRunning(input.record.hostThreadId);
    const externalThread: ExternalThread = {
      id: input.record.hostThreadId,
      cwd: input.record.cwd,
      harnessId,
      session: input.session,
      outputTask: Promise.resolve(),
      ...(effectiveModel ? { requestedModel: effectiveModel } : {}),
      ...(effectiveThinkingOptionId
        ? { requestedThinkingOptionId: effectiveThinkingOptionId }
        : {}),
      ...(effectivePermissionModeId
        ? { requestedPermissionModeId: effectivePermissionModeId }
        : {}),
      record: input.record,
      unsubmittedPrewarm: input.unsubmittedPrewarm === true,
      sessionId: input.sessionId,
      stateObserver: new SessionStateObserver(observerState),
      thread: running
        ? { ...input.thread, status: { type: "active", activeFlags: [] } }
        : input.thread,
      transportModelId: input.transportModelId ?? input.record.transportModelId,
      turns: input.turns,
      historyHydrated: true,
      running,
      activeTurnId: null,
      latestUsage: input.session.initialUsage,
      usageMeter: new UsageMeter(),
      usageTurnId: null,
      projectedTurns: new Map(),
      responseGates: new Map(),
      ephemeralTurnIds: new Set(),
      persistenceError: null,
      projectedTerminalTurnId: null,
      ignoredInteractionIds: new Set(),
      pendingInjectedText: [],
      sessionUnavailable: false,
    };
    this.idleRelease.touch(externalThread);
    externalThread.outputTask = this.#consumeOutputs(externalThread);
    this.#threads.set(externalThread.id, externalThread);
    return externalThread;
  }

  /** Commit before executing user work; return whether a Thread can now be published. */
  async submitPrewarm(thread: ExternalThread): Promise<boolean> {
    if (!thread.unsubmittedPrewarm) return false;
    const nativeRef = thread.stateObserver.state.nativeRef;
    if (nativeRef) {
      thread.record = await this.#repository.commitNative(thread.id, nativeRef);
    }
    // If identity is deferred, its later Session event will commit and publish it.
    // Keep the draft hidden on persistence failure, without executing user work.
    thread.unsubmittedPrewarm = false;
    return thread.record.state === "ready";
  }

  async replace(
    current: ExternalThread,
    input: {
      record: StoredThreadRecordV1;
      session: HarnessSession;
      sessionId: string;
      thread: JsonObject;
      turns: JsonObject[];
      restoredState?: HarnessSessionState;
    },
  ): Promise<ExternalThread> {
    if (
      current.running ||
      this.#threads.get(current.id) !== current ||
      input.record.hostThreadId !== current.id
    ) {
      throw new Error("External Thread runtime cannot replace an active or stale Session");
    }
    // Rollback callers have already committed input.record and own the replacement.
    // Preserve their existing best-effort close semantics; this is not fault recovery.
    try {
      await current.session.close();
      await current.outputTask;
    } catch (error) {
      this.#diagnose(error);
    }
    await this.#retireSubagents(current, true);
    this.#threads.delete(current.id);
    return this.register(input);
  }

  async #retireSubagents(parent: ExternalThread, bestEffort = false): Promise<void> {
    const parentId = parent.id;
    const ancestors = new Map<string, Promise<StoredThreadRecordV1 | null>>();
    const descendant = async (record: StoredThreadRecordV1 | null): Promise<boolean> => {
      const visited = new Set<string>();
      let ownerId = record?.subagent?.parentHostThreadId;
      while (ownerId && !visited.has(ownerId)) {
        if (ownerId === parentId) return true;
        visited.add(ownerId);
        let ancestor = ancestors.get(ownerId);
        if (!ancestor) {
          ancestor = this.#repository.find(ownerId);
          ancestors.set(ownerId, ancestor);
        }
        ownerId = (await ancestor)?.subagent?.parentHostThreadId;
      }
      return false;
    };
    // A descendant may be open without its intermediate parent loaded. Follow
    // stored ancestry, including in-flight restores, not just loaded children.
    for (const [id, pending] of this.#lifecycle.pending()) {
      if (id !== parentId && (await descendant(await this.#repository.find(id)))) await pending;
    }
    for (const child of [...this.#threads.values()]) {
      if (!(await descendant(child.record))) continue;
      const retire = async () => {
        if (this.#threads.get(parentId) !== parent || this.#threads.get(child.id) !== child) return;
        if (bestEffort) {
          this.#threads.delete(child.id);
          await child.session.close();
          await child.outputTask;
        } else {
          child.sessionUnavailable = true;
          await this.#lifecycle.release(child.id, child.session, child.outputTask);
          if (this.#threads.get(child.id) === child) this.#threads.delete(child.id);
        }
      };
      if (bestEffort) await retire().catch(this.#diagnose);
      else await this.#withLifecycle(child.id, retire);
    }
  }

  async locate(threadId: string): Promise<ExternalThreadLocation> {
    try {
      return await this.#withLifecycle(threadId, () => this.#locate(threadId));
    } catch (error) {
      return { kind: "error", error: recoveryError(error) };
    }
  }

  async #locate(threadId: string): Promise<ExternalThreadLocation> {
    const loaded = this.#threads.get(threadId);
    if (loaded) {
      const failure = this.idleRelease.failure(loaded);
      if (failure) return { kind: "error", error: { code: -32075, message: failure } };
      return { kind: "external", record: loaded.record, thread: loaded };
    }
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
    try {
      return await this.#withLifecycle(threadId, async () => {
        // Read after admission, never act on a location captured before another recovery.
        const location = await this.#locate(threadId);
        if (location.kind !== "external") return location;
        if (location.thread) {
          if (location.thread.sessionUnavailable && this.#idleForRestore(location.thread)) {
            await this.#dropIdleSession(location.thread);
            // register/remove can be used by other Host lifecycle owners. A late close must
            // neither remove their replacement nor open a second owner over it.
            const current = this.#threads.get(threadId);
            if (current) return { kind: "external", thread: current, historyFresh: false };
          } else {
            this.idleRelease.touch(location.thread);
            return { kind: "external", thread: location.thread, historyFresh: false };
          }
        }
        return {
          kind: "external",
          thread: await this.#restore(location.record),
          historyFresh: true,
        };
      });
    } catch (error) {
      return { kind: "error", error: recoveryError(error) };
    }
  }

  async refresh(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
    try {
      return await this.#withLifecycle(thread.id, () => this.#refresh(thread));
    } catch (error) {
      return recoveryError(error);
    }
  }

  async #refresh(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
    if (this.#threads.get(thread.id) !== thread) {
      return {
        code: -32076,
        message: "External Session changed during recovery; retry the request",
      };
    }
    const failure = this.idleRelease.failure(thread);
    if (failure) return { code: -32075, message: failure };
    if (thread.sessionUnavailable && this.#idleForRestore(thread)) {
      const revived = await this.#reviveIdleSession(thread);
      if (revived) return revived;
    }
    let snapshot = await thread.session.readSnapshot();
    if (!snapshot.ok) {
      // A faulted/closed Session stays registered until we drop it; revive in place so
      // callers that already hold this ExternalThread keep working after restore.
      if (
        snapshot.error.code === "invalidState" &&
        this.#idleForRestore(thread) &&
        this.#threads.get(thread.id) === thread
      ) {
        const revived = await this.#reviveIdleSession(thread);
        if (revived) return revived;
        snapshot = await thread.session.readSnapshot();
        if (!snapshot.ok) return mapExternalThreadHarnessError(snapshot.error, "read");
      } else {
        return mapExternalThreadHarnessError(snapshot.error, "read");
      }
    }
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

  async #reviveIdleSession(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
    thread.sessionUnavailable = true;
    const harnessId = thread.record.harnessId as ExternalHarnessId;
    const adapter = this.#adapters.get(harnessId);
    if (!adapter || !thread.record.nativeSessionRef) {
      await this.#dropIdleSession(thread);
      return { code: -32077, message: "External Harness is unavailable" };
    }
    await this.#lifecycle.release(thread.id, thread.session, thread.outputTask);
    await this.#retireSubagents(thread);
    if (this.#threads.get(thread.id) !== thread) {
      return { code: -32076, message: "External Thread recovery failed" };
    }
    const restoredSelection = decodeExternalTransportSelection(
      harnessId,
      thread.record.transportModelId,
    );
    const opened = await adapter.open({
      kind: "resume",
      cwd: thread.record.cwd,
      environment: { ...this.#environment, [DELEGATION_THREAD_ID_ENV]: thread.record.hostThreadId },
      nativeRef: thread.record.nativeSessionRef as NativeSessionRef,
      knownTurnRefs: thread.record.turnMappings.map(({ nativeTurnRef }) => nativeTurnRef),
      ...(restoredSelection?.model ? { model: restoredSelection.model } : {}),
      ...(restoredSelection?.thinkingOptionId
        ? { thinkingOptionId: restoredSelection.thinkingOptionId }
        : {}),
      ...(restoredSelection?.permissionModeId
        ? { permissionModeId: restoredSelection.permissionModeId }
        : {}),
    });
    if (!opened.ok) {
      await this.#dropIdleSession(thread);
      return mapExternalThreadHarnessError(opened.error, "resume");
    }
    const session = opened.value;
    if (this.#threads.get(thread.id) !== thread) {
      await this.#lifecycle.release(thread.id, session, Promise.resolve());
      return { code: -32076, message: "External Thread recovery failed" };
    }
    try {
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) {
        await this.#lifecycle.release(thread.id, session, Promise.resolve());
        await this.#dropIdleSession(thread);
        return mapExternalThreadHarnessError(snapshot.error, "read");
      }
      let aligned = await this.#repository.alignSnapshot(thread.record, snapshot.value);
      if (this.#threads.get(thread.id) !== thread) {
        await this.#lifecycle.release(thread.id, session, Promise.resolve());
        return { code: -32076, message: "External Thread recovery failed" };
      }
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
      // Native confirmed state wins over persisted configuration hints for every plugin.
      if (restoredState && effectiveModel) {
        const liveSelection: ExternalConfigurationSelection = {
          model: effectiveModel,
          ...(effectiveThinkingOptionId ? { thinkingOptionId: effectiveThinkingOptionId } : {}),
          ...(effectivePermissionModeId ? { permissionModeId: effectivePermissionModeId } : {}),
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
      if (this.#threads.get(thread.id) !== thread) {
        await this.#lifecycle.release(thread.id, session, Promise.resolve());
        return { code: -32076, message: "External Thread recovery failed" };
      }
      const initialState = restoredState ?? session.initialState;
      const observerState: HarnessSessionState = {
        ...initialState,
        ...(effectiveModel ? { effectiveModel } : {}),
        ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
        ...(effectivePermissionModeId ? { effectivePermissionModeId } : {}),
      };
      thread.session = session;
      thread.record = aligned.record;
      thread.turns = aligned.turns;
      thread.historyHydrated = true;
      thread.sessionUnavailable = false;
      thread.persistenceError = null;
      thread.transportModelId = transportModelId;
      if (effectiveModel) thread.requestedModel = effectiveModel;
      if (effectiveThinkingOptionId) thread.requestedThinkingOptionId = effectiveThinkingOptionId;
      if (effectivePermissionModeId) thread.requestedPermissionModeId = effectivePermissionModeId;
      thread.stateObserver = new SessionStateObserver(observerState);
      thread.latestUsage = session.initialUsage;
      thread.usageMeter = new UsageMeter();
      thread.usageTurnId = null;
      thread.thread = externalThreadValue({
        record: aligned.record,
        turns: aligned.turns,
        sessionId: thread.sessionId,
        running: thread.running,
      });
      thread.outputTask = this.#consumeOutputs(thread);
      this.idleRelease.clearOutputFailed(thread);
      return null;
    } catch (error) {
      if (error instanceof ExternalSessionReleaseError) throw error;
      await this.#lifecycle.release(thread.id, session, Promise.resolve());
      this.#diagnose(error);
      await this.#dropIdleSession(thread);
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
      const latest = await this.#repository.find(record.hostThreadId);
      if (
        latest?.state === "ready" &&
        latest.nativeSessionRef &&
        JSON.stringify(latest.nativeSessionRef) !== JSON.stringify(parent)
      ) {
        return this.#restore(latest);
      }
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
      return this.register({
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
      ...(restoredSelection?.model ? { model: restoredSelection.model } : {}),
      ...(restoredSelection?.thinkingOptionId
        ? { thinkingOptionId: restoredSelection.thinkingOptionId }
        : {}),
      ...(restoredSelection?.permissionModeId
        ? { permissionModeId: restoredSelection.permissionModeId }
        : {}),
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
      // Native confirmed state wins over persisted configuration hints for every plugin.
      if (restoredState && effectiveModel) {
        const liveSelection: ExternalConfigurationSelection = {
          model: effectiveModel,
          ...(effectiveThinkingOptionId ? { thinkingOptionId: effectiveThinkingOptionId } : {}),
          ...(effectivePermissionModeId ? { permissionModeId: effectivePermissionModeId } : {}),
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
      if (error instanceof ExternalSessionReleaseError) throw error;
      await this.#lifecycle.release(record.hostThreadId, session, Promise.resolve());
      throw error;
    }
  }
}
