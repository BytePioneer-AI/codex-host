import { randomUUID } from "node:crypto";
import type {
  HarnessAdapter,
  HarnessModelRef,
  HarnessResult,
  HarnessSession,
  HarnessSessionState,
  HostThreadSnapshot,
  HostTurnSnapshot,
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
  type TodoPlan,
} from "@codexhost/protocol-core";
import { HarnessOutputChannel } from "@codexhost/harness-adapter";
import {
  hostTurnIdSchema,
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
import { projectExternalTurn } from "./external-subagent-threads.js";
import { withFailedTurns, type LiveFailedTurn } from "./external-turn-projection.js";
import { ownTurns } from "./external-thread-side-chat.js";
import { reconcileExternalTurnItemIds } from "./external-turn-item-ids.js";
import {
  ExternalSessionReleaseError,
  ExternalThreadLifecycle,
} from "./external-thread-lifecycle.js";
import { UsageMeter } from "@codexhost/session-runtime/usage-metering";

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
  historicalPlans: ReadonlyMap<string, TodoPlan>;
  historyHydrated: boolean;
  running: boolean;
  activeTurnId: HostTurnId | null;
  // Terminal Turn projected by this process that is still the latest Turn
  // attempt; any later start clears it. A read may report it when native
  // history cannot be refreshed.
  projectedTerminalTurnId: HostTurnId | null;
  latestUsage: HostUsage | null;
  /** turn/plan/updated params projected live since history was last loaded; newer than history. */
  livePlan: JsonObject | null;
  /** Host metering for the current Session only; replaced with it. */
  usageMeter: UsageMeter;
  usageTurnId: HostTurnId | null;
  projectedTurns: Map<HostTurnId, { projector: CodexTurnProjector }>;
  responseGates: Map<HostTurnId, TurnProjectionGate>;
  pendingSteerProjections: Set<Promise<void>>;
  ephemeralTurnIds: Set<HostTurnId>;
  /** Latest explicit command, retained only for client lifecycle presentation. */
  clientCommand?: { name: string; turn: JsonObject; subsequentTurnId?: HostTurnId };
  persistenceError: Error | null;
  ignoredInteractionIds: Set<HostInteractionId>;
  /** Native Session faulted or closed; idle Threads should restore instead of reuse. */
  sessionUnavailable: boolean;
  /**
   * Turns that took native steered input since Desktop last read this Thread's history. Desktop
   * still shows each as one Turn, while native history may have split it at the steered input.
   */
  steeredTurnIds: Set<HostTurnId>;
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

function nativeTurnKey(turn: { nativeTurnRef: HostTurnSnapshot["nativeTurnRef"] }): string {
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
  readonly #steeredTurnIds = new Map<string, Set<HostTurnId>>();
  readonly #subagentRunning: (threadId: string) => boolean;
  readonly #threads = new Map<string, ExternalThread>();
  readonly #liveFailures = new Map<string, Map<string, LiveFailedTurn>>();
  // Only completed snapshots mutate this ledger; never hold this gate while
  // closing a Session (close drains its outputs).
  readonly #historyWrites = new DesktopRequestQueue();
  readonly #onWorkspace: ((cwd: string) => void) | undefined;

  constructor(input: {
    adapters: Map<ExternalHarnessId, HarnessAdapter>;
    environment?: NodeJS.ProcessEnv;
    repository: ExternalThreadRepository;
    consumeOutputs(thread: ExternalThread): Promise<void>;
    onWorkspace?(cwd: string): void;
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
    this.#onWorkspace = input.onWorkspace;
    this.#diagnose = input.diagnose;
    this.#subagentRunning = input.subagentRunning ?? (() => false);
    this.#hasRunningDescendants = input.hasRunningDescendants ?? (() => false);
    this.idleRelease = new ExternalThreadIdleRelease({
      threads: () => this.values(),
      get: (id) => this.get(id),
      // Idle release detaches only the Native Session. Host Thread state survives restoration.
      remove: (id) => this.#detach(id),
      queue: input.idleRelease?.queue ?? new DesktopRequestQueue(),
      canRelease: (thread) =>
        !thread.sessionUnavailable &&
        !this.#lifecycle.busy(thread.id) &&
        (input.idleRelease?.canRelease(thread) ?? false),
      onClosed: async (thread) => {
        await this.persistUsageMeasurements(thread);
        await input.idleRelease?.onClosed?.(thread);
      },
      diagnose: input.diagnose,
    });
  }

  get(threadId: string): ExternalThread | undefined {
    return this.#threads.get(threadId);
  }

  #detach(threadId: string): void {
    const thread = this.#threads.get(threadId);
    this.#threads.delete(threadId);
    if (!thread || thread.steeredTurnIds.size === 0) this.#steeredTurnIds.delete(threadId);
  }

  values(): ExternalThread[] {
    return [...this.#threads.values()];
  }

  remove(threadId: string): void {
    this.#liveFailures.delete(threadId);
    this.#threads.delete(threadId);
    this.#steeredTurnIds.delete(threadId);
  }

  /** Confirm release before forgetting either the Session owner or its persisted mapping. */
  async deleteThread(hostThreadId: StoredThreadRecordV1["hostThreadId"]): Promise<void> {
    await this.#withLifecycle(hostThreadId, async () => {
      const thread = this.#threads.get(hostThreadId);
      if (thread) {
        thread.sessionUnavailable = true;
        thread.stateObserver.fault(new Error("External Thread is being deleted"));
        await this.#lifecycle.release(hostThreadId, thread.session, thread.outputTask);
      }
      this.remove(hostThreadId);
      await this.#repository.removeThread(hostThreadId);
    });
  }

  clear(): void {
    this.#liveFailures.clear();
    this.#threads.clear();
    this.#steeredTurnIds.clear();
  }

  drain(): Promise<void> {
    return this.#lifecycle.drain();
  }

  async adoptImported(record: StoredThreadRecordV1, session: HarnessSession): Promise<void> {
    await this.#withLifecycle(record.hostThreadId, async () => {
      if (this.#threads.has(record.hostThreadId)) {
        await session.close();
        return;
      }
      await this.#restore(record, session);
    });
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
    await this.persistUsageMeasurements(thread);
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
    historicalPlans?: ReadonlyMap<string, TodoPlan>;
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
    let steeredTurnIds = this.#steeredTurnIds.get(input.record.hostThreadId);
    if (!steeredTurnIds) {
      steeredTurnIds = new Set();
      this.#steeredTurnIds.set(input.record.hostThreadId, steeredTurnIds);
    }
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
      historicalPlans: input.historicalPlans ?? new Map(),
      historyHydrated: true,
      running,
      activeTurnId: null,
      latestUsage: input.session.initialUsage,
      livePlan: null,
      usageMeter: new UsageMeter(),
      usageTurnId: null,
      projectedTurns: new Map(),
      responseGates: new Map(),
      pendingSteerProjections: new Set(),
      ephemeralTurnIds: new Set(),
      persistenceError: null,
      projectedTerminalTurnId: null,
      ignoredInteractionIds: new Set(),
      sessionUnavailable: false,
      steeredTurnIds,
    };
    this.#restoreUsageMeasurements(externalThread);
    this.idleRelease.touch(externalThread);
    externalThread.outputTask = this.#consumeOutputs(externalThread);
    this.#threads.set(externalThread.id, externalThread);
    this.#onWorkspace?.(externalThread.cwd);
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
      historicalPlans: ReadonlyMap<string, TodoPlan>;
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
    const live = this.#liveFailures.get(current.id);
    if (live) {
      const undone = new Set<string>(
        current.record.turnMappings
          .slice(input.record.turnMappings.length)
          .map(({ hostTurnId }) => hostTurnId),
      );
      for (const [id, entry] of live) {
        const { afterTurnId } = entry.failure;
        if (undone.has(id) || (afterTurnId && undone.has(afterTurnId))) {
          live.delete(id);
        } else {
          entry.failure = {
            ...entry.failure,
            nativeTurnRef: input.record.turnMappings.find(({ hostTurnId }) => hostTurnId === id)
              ?.nativeTurnRef,
          };
        }
      }
    }
    const turns = this.#mergeFailedTurns(input.record, input.turns);
    this.#threads.delete(current.id);
    return this.register({
      ...input,
      turns,
      thread: { ...input.thread, turns: ownTurns(input.record, turns) },
    });
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
          this.remove(child.id);
          await child.session.close();
          await child.outputTask;
        } else {
          child.sessionUnavailable = true;
          await this.#lifecycle.release(child.id, child.session, child.outputTask);
          if (this.#threads.get(child.id) === child) this.remove(child.id);
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
    for (let attempt = 0; attempt < 3; attempt++) {
      let recordAtRead = thread.record;
      let snapshot = await thread.session.readSnapshot();
      if (!snapshot.ok) {
        // A faulted/closed Session stays registered until it can be revived in place.
        if (
          snapshot.error.code !== "invalidState" ||
          !this.#idleForRestore(thread) ||
          this.#threads.get(thread.id) !== thread
        ) {
          return mapExternalThreadHarnessError(snapshot.error, "read");
        }
        const revived = await this.#reviveIdleSession(thread);
        if (revived) return revived;
        recordAtRead = thread.record;
        snapshot = await thread.session.readSnapshot();
        if (!snapshot.ok) return mapExternalThreadHarnessError(snapshot.error, "read");
      }
      const read = snapshot.value;
      let stale = false;
      try {
        await this.#historyWrites.run(thread.id, async () => {
          // A live append may have installed newer history. Retry instead of losing either
          // that mapping or older native Turns discovered by this read.
          if (thread.record.revision !== recordAtRead.revision) {
            stale = true;
            return;
          }
          const aligned = await this.#repository.alignSnapshot(
            thread.record,
            read,
            this.#failedTurns(thread.record),
          );
          // Before native identity exists, an empty Snapshot cannot reconcile the
          // failed or cancelled Turns retained only in this loaded Host Thread.
          const turns =
            aligned.record.state === "creating" &&
            !aligned.record.nativeSessionRef &&
            read.turns.length === 0
              ? thread.turns
              : this.#reconcileHistoryTurns(
                  thread,
                  this.#mergeFailedTurns(aligned.record, aligned.turns),
                );
          thread.record = aligned.record;
          if (turns !== thread.turns) {
            thread.livePlan = null;
            thread.historicalPlans = aligned.historicalPlans;
          }
          thread.turns = turns;
          thread.historyHydrated = true;
          thread.thread = externalThreadValue({
            record: aligned.record,
            turns,
            sessionId: thread.sessionId,
            running: thread.running,
          });
        });
      } catch {
        return { code: -32081, message: "External Thread history could not be persisted" };
      }
      if (!stale) return null;
    }
    return {
      code: -32081,
      message: "External Thread history changed during read; retry the request",
    };
  }

  #failedTurns(record: StoredThreadRecordV1) {
    const durable = record.failedTurns ?? [];
    const live = this.#liveFailures.get(record.hostThreadId);
    if (!live?.size) return durable;
    // Keep the durable prefix and live tail in order even if a live write failed.
    return [
      ...durable.filter(({ hostTurnId }) => !live.has(hostTurnId)),
      ...Array.from(live.values(), ({ failure }) => failure),
    ];
  }

  #mergeFailedTurns(record: StoredThreadRecordV1, native: JsonObject[]): JsonObject[] {
    return withFailedTurns(
      native,
      this.#failedTurns(record),
      this.#liveFailures.get(record.hostThreadId),
    );
  }

  /** Native mapping positions count toward the range even if their contents are unavailable. */
  async retainedFailure(threadId: string) {
    const loaded = this.get(threadId);
    const record = loaded?.record ?? (await this.#repository.find(threadId));
    if (!record || loaded?.activeTurnId) return;
    const turns = this.#mergeFailedTurns(
      record,
      record.turnMappings.map(({ hostTurnId }) => ({ id: hostTurnId })),
    );
    const latest = turns.at(-1);
    if (latest?.status !== "failed" || (loaded && loaded.projectedTerminalTurnId !== latest.id))
      return;
    return { record, turns: turns.map((turn) => (turn.status === "failed" ? turn : undefined)) };
  }

  #reconcileHistoryTurns(thread: ExternalThread, turns: JsonObject[]): JsonObject[] {
    const previous = thread.turns.map((turn) => {
      const background = thread.projectedTurns
        .get(turn.id as HostTurnId)
        ?.projector.backgroundWireItems();
      if (!background?.size || !Array.isArray(turn.items)) return turn;
      // The background replay overlay owns reconciliation of post-Turn text.
      // Settled background Items can also be present in the cached snapshot.
      const backgroundIds = new Set<unknown>(background.keys());
      for (const item of background.values()) backgroundIds.add(item.id);
      const items = turn.items.filter(
        (item) =>
          !(item && typeof item === "object" && !Array.isArray(item) && backgroundIds.has(item.id)),
      );
      return { ...turn, items };
    });
    return reconcileExternalTurnItemIds(previous, turns);
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
      let aligned = await this.#repository.alignSnapshot(
        thread.record,
        snapshot.value,
        this.#failedTurns(thread.record),
      );
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
      const turns = this.#reconcileHistoryTurns(
        thread,
        this.#mergeFailedTurns(aligned.record, aligned.turns),
      );
      thread.session = session;
      thread.record = aligned.record;
      thread.turns = turns;
      thread.historicalPlans = aligned.historicalPlans;
      thread.livePlan = null;
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
      this.#restoreUsageMeasurements(thread);
      thread.usageTurnId = null;
      thread.thread = externalThreadValue({
        record: aligned.record,
        turns,
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

  /** Only confirmed successful work may provide a durable live preview. */
  async captureCompletedPreview(thread: ExternalThread, turn: JsonObject): Promise<void> {
    if (
      thread.record.preview !== undefined ||
      thread.record.turnMappings.at(-1)?.hostTurnId !== turn.id
    )
      return;
    try {
      thread.record = await this.#repository.updatePreview(thread.record, [turn]);
      thread.thread.preview = thread.record.preview ?? "";
    } catch (error) {
      this.#diagnose(error);
    }
  }

  #restoreUsageMeasurements(thread: ExternalThread): void {
    const saved = thread.record.usageMeasurements;
    if (
      !saved ||
      JSON.stringify(saved.nativeSessionRef) !== JSON.stringify(thread.record.nativeSessionRef)
    )
      return;
    const retained = new Set<string>(
      thread.record.turnMappings.map((mapping) => mapping.hostTurnId),
    );
    thread.usageMeter.restoreOutputTimings(
      saved.values.outputTimings?.filter((value) => retained.has(value.turnId)) ?? [],
    );
    for (const field of ["outputTokensPerSecond", "timeToFirstOutputMs"] as const) {
      const value = saved.values[field];
      if (value && retained.has(value.turnId))
        thread.usageMeter.restoreMeasurements({ [field]: value.value }, value.turnId, value.at);
    }
  }

  /** Save display telemetry at lifecycle boundaries; optional failures cannot fail native work. */
  async persistUsageMeasurements(thread: ExternalThread): Promise<void> {
    if (this.#threads.get(thread.id) !== thread || thread.record.state !== "ready") return;
    const snapshot = thread.usageMeter.measurementSnapshot(
      thread.latestUsage,
      thread.usageTurnId ?? thread.record.turnMappings.at(-1)?.hostTurnId,
    );
    const previous = thread.record.usageMeasurements;
    if (
      previous &&
      JSON.stringify(previous.nativeSessionRef) === JSON.stringify(thread.record.nativeSessionRef)
    ) {
      for (const field of ["outputTokensPerSecond", "timeToFirstOutputMs"] as const) {
        const before = previous.values[field],
          next = snapshot[field];
        if (before && next && before.value === next.value && before.turnId === next.turnId)
          snapshot[field] = before;
      }
    }
    if (!Object.keys(snapshot).length && !previous) return;
    try {
      const saved = await this.#repository.saveUsageMeasurements(thread.record, snapshot);
      if (
        this.#threads.get(thread.id) !== thread ||
        JSON.stringify(saved.nativeSessionRef) !== JSON.stringify(thread.record.nativeSessionRef)
      )
        return;
      if (saved.usageMeasurements)
        thread.record = { ...thread.record, usageMeasurements: saved.usageMeasurements };
      else delete thread.record.usageMeasurements;
    } catch (error) {
      this.#diagnose(error);
    }
  }

  async appendAutonomousTurn(
    thread: ExternalThread,
    snapshot: HostTurnSnapshot,
  ): Promise<JsonObject | undefined> {
    let turn: JsonObject | undefined;
    await this.#historyWrites.run(thread.id, async () => {
      const key = nativeTurnKey(snapshot);
      const existing = thread.record.turnMappings.find((mapping) => nativeTurnKey(mapping) === key);
      if (existing && thread.turns.some(({ id }) => id === existing.hostTurnId)) return;
      const turnId = existing?.hostTurnId ?? hostTurnIdSchema.parse(randomUUID());
      thread.record = await this.#repository.persistTurn(
        thread.record,
        turnId,
        snapshot.nativeTurnRef,
        snapshot.checkpoint,
      );
      const record = thread.record;
      const projected = await projectExternalTurn(record, turnId, snapshot, (child) =>
        this.#repository.materializeSubagent(record, child),
      );
      thread.turns.push(projected);
      const updatedAt = Math.floor(Date.now() / 1000);
      thread.thread.updatedAt = updatedAt;
      thread.thread.recencyAt = updatedAt;
      if (!thread.activeTurnId) thread.projectedTerminalTurnId = turnId;
      if (thread.clientCommand) thread.clientCommand.subsequentTurnId ??= turnId;
      turn = projected;
    });
    return turn;
  }

  /**
   * Marks a Turn starting or ending as Thread activity. Status notifications reach only the
   * connection that runs the Turn; other clients' thread catalogs re-read only rows whose
   * updatedAt moved past what they have seen.
   */
  async touch(thread: ExternalThread): Promise<void> {
    try {
      thread.record = await this.#repository.touch(thread.id);
      const updatedAt = Math.floor(Date.parse(thread.record.updatedAt) / 1_000);
      if (typeof thread.thread.updatedAt !== "number" || updatedAt > thread.thread.updatedAt)
        thread.thread.updatedAt = updatedAt;
      if (typeof thread.thread.recencyAt !== "number" || updatedAt > thread.thread.recencyAt)
        thread.thread.recencyAt = updatedAt;
    } catch (error) {
      this.#diagnose(error);
    }
  }

  async retainFailedTurn(
    thread: ExternalThread,
    event: TurnCompletedEvent,
    turn: JsonObject,
  ): Promise<void> {
    if (event.outcome.status !== "failed") return;
    const code = event.outcome.error.code;
    const error = code === "authenticationRequired" ? "authenticationRequired" : "executionFailed";
    await this.#historyWrites.run(thread.id, async () => {
      const afterTurnId = thread.record.turnMappings.findLast(
        ({ hostTurnId }) => hostTurnId !== event.turnId,
      )?.hostTurnId;
      const nativeTurnRef =
        thread.record.turnMappings.find(({ hostTurnId }) => hostTurnId === event.turnId)
          ?.nativeTurnRef ?? event.nativeTurnRef;
      const failure = { hostTurnId: event.turnId, afterTurnId, nativeTurnRef, error } as const;
      const live = this.#liveFailures.get(thread.id) ?? new Map<string, LiveFailedTurn>();
      const items = Array.isArray(turn.items)
        ? turn.items.filter(
            (item): item is JsonObject =>
              item !== null &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              (item.type === "userMessage" || item.type === "agentMessage"),
          )
        : [];
      live.set(event.turnId, { failure, items });
      this.#liveFailures.set(thread.id, live);
      this.#diagnose(
        `External Turn failed (harnessId=${thread.harnessId}, threadId=${thread.id}, turnId=${event.turnId}, phase=execute, code=${code})`,
      );
      try {
        thread.record = await this.#repository.saveFailedTurn(thread.record, failure);
      } catch {
        this.#diagnose(
          `Failed Turn metadata could not be saved (threadId=${thread.id}, turnId=${event.turnId})`,
        );
      }
    });
  }

  async persistTerminalIdentity(
    thread: ExternalThread,
    event: TurnCompletedEvent,
  ): Promise<Error | null> {
    const nativeTurnRef = event.nativeTurnRef;
    if (!nativeTurnRef) {
      await this.persistUsageMeasurements(thread);
      return event.outcome.status === "succeeded"
        ? new Error("Successful external Turn has no Native Turn identity")
        : null;
    }
    try {
      await this.#historyWrites.run(thread.id, async () => {
        thread.record = await this.#repository.persistTurn(
          thread.record,
          event.turnId,
          nativeTurnRef,
          event.outcome.checkpoint,
        );
      });
      thread.persistenceError = null;
      await this.persistUsageMeasurements(thread);
      return null;
    } catch (error) {
      const failure = new Error(
        `External Turn identity could not be persisted: ${errorMessage(error)}`,
        { cause: error },
      );
      thread.persistenceError = failure;
      thread.stateObserver.fault(failure);
      this.#diagnose(failure);
      return failure;
    }
  }

  async #restore(
    record: StoredThreadRecordV1,
    preparedSession?: HarnessSession,
  ): Promise<ExternalThread> {
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
        historicalPlans: aligned.historicalPlans,
        ...(snapshot.value.state ? { restoredState: snapshot.value.state } : {}),
      });
    }
    const restoredSelection = decodeExternalTransportSelection(harnessId, record.transportModelId);
    const opened = preparedSession
      ? { ok: true as const, value: preparedSession }
      : await adapter.open({
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
      let aligned = await this.#repository.alignSnapshot(
        record,
        snapshot.value,
        this.#failedTurns(record),
      );
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
      const turns = this.#mergeFailedTurns(aligned.record, aligned.turns);
      return this.register({
        record: aligned.record,
        session,
        sessionId,
        thread: externalThreadValue({ record: aligned.record, turns, sessionId }),
        turns,
        historicalPlans: aligned.historicalPlans,
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
