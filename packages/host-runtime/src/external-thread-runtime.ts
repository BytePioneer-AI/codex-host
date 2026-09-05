import type {
  HarnessAdapter,
  HarnessModelRef,
  HarnessSession,
  HarnessSessionState,
  HostUsage,
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
import {
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostThreadId,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import { ExternalThreadResolver } from "./external-thread-resolver.js";
import { SessionStateObserver } from "./session-state-observer.js";

export interface TurnProjectionGate {
  promise: Promise<void>;
  resolve(): void;
}

export interface ExternalThreadHistoryMutation {
  readonly threadId: HostThreadId;
  readonly token: symbol;
}

export interface ExternalThreadHistoryReplacement {
  readonly threadId: HostThreadId;
  readonly token: symbol;
}

export interface ExternalThreadSessionAccess {
  readonly threadId: HostThreadId;
  readonly token: symbol;
}

interface ExternalThreadHistoryRefresh {
  readonly threadId: HostThreadId;
  readonly token: symbol;
}

export interface ExternalThreadOutputProjection {
  readonly threadId: HostThreadId;
  readonly token: symbol;
}

interface ExternalThreadHistoryMutationState extends ExternalThreadHistoryMutation {
  invalidated: boolean;
  phase: "deriving" | "fencing" | "committing";
  sourceMustBeReloaded: boolean;
  promise: Promise<void>;
  resolve(value: undefined): void;
}

interface ExternalThreadHistoryReplacementState extends ExternalThreadHistoryReplacement {
  mutationToken: symbol;
  nativeRef: NativeSessionRef;
  session: HarnessSession;
}

interface ExternalThreadHistoryRefreshState extends ExternalThreadHistoryRefresh {
  pendingOutput: boolean;
  promise: Promise<void>;
  resolve(value: undefined): void;
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
  sessionId: string;
  stateObserver: SessionStateObserver;
  thread: JsonObject;
  transportModelId: string;
  turns: JsonObject[];
  historyHydrated: boolean;
  running: boolean;
  activeTurnId: HostTurnId | null;
  latestUsage: HostUsage | null;
  usageTurnId: HostTurnId | null;
  projectedTurns: Map<HostTurnId, { projector: CodexTurnProjector }>;
  responseGates: Map<HostTurnId, TurnProjectionGate>;
  ephemeralTurnIds: Set<HostTurnId>;
  persistenceError: Error | null;
  ignoredInteractionIds: Set<HostInteractionId>;
  historyMutation: ExternalThreadHistoryMutationState | null;
  historyRefresh: ExternalThreadHistoryRefreshState | null;
  outputProjections: Set<symbol>;
  sessionAccesses: Set<symbol>;
}

export interface ExternalThreadRegistration {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExternalThreadRuntime {
  readonly #adapters: Map<ExternalHarnessId, HarnessAdapter>;
  readonly #consumeOutputs: (thread: ExternalThread) => Promise<void>;
  readonly #diagnose: (error: unknown) => void;
  readonly #historyReplacements = new Map<symbol, ExternalThreadHistoryReplacementState>();
  readonly #repository: ExternalThreadRepository;
  readonly #resolver: ExternalThreadResolver;
  readonly #threads = new Map<string, ExternalThread>();

  constructor(input: {
    adapters: Map<ExternalHarnessId, HarnessAdapter>;
    environment?: NodeJS.ProcessEnv;
    repository: ExternalThreadRepository;
    consumeOutputs(thread: ExternalThread): Promise<void>;
    diagnose(error: unknown): void;
  }) {
    this.#adapters = input.adapters;
    this.#repository = input.repository;
    this.#consumeOutputs = input.consumeOutputs;
    this.#diagnose = input.diagnose;
    this.#resolver = new ExternalThreadResolver({
      diagnose: input.diagnose,
      environment: input.environment ?? process.env,
      lookupAdapter: (harnessId) => this.#adapters.get(harnessId),
      lookupLoaded: (threadId) => this.#threads.get(threadId),
      register: (registration) => this.register(registration),
      repository: input.repository,
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
    this.#resolver.clearPending();
    this.#historyReplacements.clear();
  }

  register(input: ExternalThreadRegistration): ExternalThread {
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
      sessionId: input.sessionId,
      stateObserver: new SessionStateObserver(observerState),
      thread: input.thread,
      transportModelId: input.transportModelId ?? input.record.transportModelId,
      turns: input.turns,
      historyHydrated: true,
      running: false,
      activeTurnId: null,
      latestUsage: input.session.initialUsage,
      usageTurnId: null,
      projectedTurns: new Map(),
      responseGates: new Map(),
      ephemeralTurnIds: new Set(),
      persistenceError: null,
      ignoredInteractionIds: new Set(),
      historyMutation: null,
      historyRefresh: null,
      outputProjections: new Set(),
      sessionAccesses: new Set(),
    };
    externalThread.outputTask = this.#consumeOutputs(externalThread);
    this.#threads.set(externalThread.id, externalThread);
    return externalThread;
  }

  beginHistoryMutation(thread: ExternalThread): ExternalThreadHistoryMutation | null {
    if (
      thread.running ||
      thread.activeTurnId !== null ||
      thread.historyMutation ||
      thread.historyRefresh ||
      thread.outputProjections.size > 0 ||
      thread.sessionAccesses.size > 0 ||
      this.#threads.get(thread.id) !== thread
    ) {
      return null;
    }
    const gate = Promise.withResolvers<undefined>();
    const mutation: ExternalThreadHistoryMutationState = {
      threadId: thread.id,
      token: Symbol("external-thread-history-mutation"),
      invalidated: false,
      phase: "deriving",
      sourceMustBeReloaded: false,
      promise: gate.promise,
      resolve: gate.resolve,
    };
    thread.historyMutation = mutation;
    return mutation;
  }

  beginSessionAccess(thread: ExternalThread): ExternalThreadSessionAccess | null {
    if (
      thread.historyMutation ||
      thread.historyRefresh ||
      this.#threads.get(thread.id) !== thread
    ) {
      return null;
    }
    const access: ExternalThreadSessionAccess = {
      threadId: thread.id,
      token: Symbol("external-thread-session-access"),
    };
    thread.sessionAccesses.add(access.token);
    return access;
  }

  endSessionAccess(thread: ExternalThread, access: ExternalThreadSessionAccess): void {
    if (access.threadId !== thread.id) return;
    thread.sessionAccesses.delete(access.token);
  }

  #beginHistoryRefresh(thread: ExternalThread): ExternalThreadHistoryRefresh | null {
    if (
      thread.historyMutation ||
      thread.historyRefresh ||
      thread.outputProjections.size > 0 ||
      thread.sessionAccesses.size > 0 ||
      this.#threads.get(thread.id) !== thread
    ) {
      return null;
    }
    const gate = Promise.withResolvers<undefined>();
    const refresh: ExternalThreadHistoryRefreshState = {
      threadId: thread.id,
      token: Symbol("external-thread-history-refresh"),
      pendingOutput: false,
      promise: gate.promise,
      resolve: gate.resolve,
    };
    thread.historyRefresh = refresh;
    return refresh;
  }

  #endHistoryRefresh(thread: ExternalThread, refresh: ExternalThreadHistoryRefresh): boolean {
    if (thread.historyRefresh?.token !== refresh.token) return true;
    const active = thread.historyRefresh;
    thread.historyRefresh = null;
    active.resolve(undefined);
    return active.pendingOutput;
  }

  beginOutputProjection(thread: ExternalThread): ExternalThreadOutputProjection | null {
    if (
      this.#threads.get(thread.id) !== thread ||
      thread.historyMutation ||
      thread.historyRefresh
    ) {
      return null;
    }
    const projection: ExternalThreadOutputProjection = {
      threadId: thread.id,
      token: Symbol("external-thread-output-projection"),
    };
    thread.outputProjections.add(projection.token);
    return projection;
  }

  async waitForOutputProjection(
    thread: ExternalThread,
  ): Promise<ExternalThreadOutputProjection | null> {
    while (this.#threads.get(thread.id) === thread) {
      const projection = this.beginOutputProjection(thread);
      if (projection) return projection;
      if (thread.historyMutation) {
        const mutation = thread.historyMutation;
        mutation.invalidated = true;
        if (mutation.phase !== "deriving") return null;
        await mutation.promise;
        continue;
      }
      if (thread.historyRefresh) {
        const refresh = thread.historyRefresh;
        refresh.pendingOutput = true;
        await refresh.promise;
        continue;
      }
      return null;
    }
    return null;
  }

  endOutputProjection(thread: ExternalThread, projection: ExternalThreadOutputProjection): void {
    if (projection.threadId !== thread.id) return;
    thread.outputProjections.delete(projection.token);
  }

  canStartSessionOperation(thread: ExternalThread): boolean {
    return (
      this.#threads.get(thread.id) === thread &&
      !thread.running &&
      thread.activeTurnId === null &&
      thread.historyMutation === null &&
      thread.historyRefresh === null &&
      thread.outputProjections.size === 0 &&
      thread.sessionAccesses.size === 0
    );
  }

  canAccessSession(thread: ExternalThread): boolean {
    return this.#threads.get(thread.id) === thread && thread.historyMutation === null;
  }

  endHistoryMutation(thread: ExternalThread, mutation: ExternalThreadHistoryMutation): void {
    if (thread.historyMutation?.token !== mutation.token) return;
    const active = thread.historyMutation;
    for (const [token, replacement] of this.#historyReplacements) {
      if (replacement.mutationToken === mutation.token) this.#historyReplacements.delete(token);
    }
    if (active.sourceMustBeReloaded && this.#threads.get(thread.id) === thread) {
      this.#threads.delete(thread.id);
    }
    thread.historyMutation = null;
    active.resolve(undefined);
  }

  #hasSessionOwner(
    session: HarnessSession,
    nativeRef: NativeSessionRef | undefined,
    ignoredReplacementToken?: symbol,
  ): boolean {
    for (const thread of this.#threads.values()) {
      if (
        thread.session === session ||
        (nativeRef &&
          thread.record.nativeSessionRef?.harnessId === nativeRef.harnessId &&
          thread.record.nativeSessionRef.nativeSessionId === nativeRef.nativeSessionId)
      ) {
        return true;
      }
    }
    for (const replacement of this.#historyReplacements.values()) {
      if (replacement.token === ignoredReplacementToken) continue;
      if (
        replacement.session === session ||
        (nativeRef &&
          replacement.nativeRef.harnessId === nativeRef.harnessId &&
          replacement.nativeRef.nativeSessionId === nativeRef.nativeSessionId)
      ) {
        return true;
      }
    }
    return false;
  }

  async closeUnownedSession(
    session: HarnessSession,
    nativeRef: NativeSessionRef | undefined = session.initialState.nativeRef,
  ): Promise<void> {
    if (this.#hasSessionOwner(session, nativeRef)) return;
    await session.close().catch(() => undefined);
  }

  isSessionOwned(
    session: HarnessSession,
    nativeRef: NativeSessionRef | undefined = session.initialState.nativeRef,
  ): boolean {
    return this.#hasSessionOwner(session, nativeRef);
  }

  #hasOtherSessionOwner(current: ExternalThread): boolean {
    const nativeRef = current.record.nativeSessionRef;
    for (const thread of this.#threads.values()) {
      if (thread === current) continue;
      if (
        thread.session === current.session ||
        (nativeRef &&
          thread.record.nativeSessionRef?.harnessId === nativeRef.harnessId &&
          thread.record.nativeSessionRef.nativeSessionId === nativeRef.nativeSessionId)
      ) {
        return true;
      }
    }
    for (const replacement of this.#historyReplacements.values()) {
      if (
        replacement.session === current.session ||
        (nativeRef &&
          replacement.nativeRef.harnessId === nativeRef.harnessId &&
          replacement.nativeRef.nativeSessionId === nativeRef.nativeSessionId)
      ) {
        return true;
      }
    }
    return false;
  }

  reserveHistoryReplacement(
    current: ExternalThread,
    mutation: ExternalThreadHistoryMutation,
    session: HarnessSession,
    nativeRef: NativeSessionRef,
  ): ExternalThreadHistoryReplacement | null {
    const active = current.historyMutation;
    if (
      this.#threads.get(current.id) !== current ||
      active?.token !== mutation.token ||
      active.phase !== "deriving" ||
      active.invalidated ||
      mutation.threadId !== current.id ||
      this.#hasSessionOwner(session, nativeRef)
    ) {
      return null;
    }
    const replacement: ExternalThreadHistoryReplacementState = {
      threadId: current.id,
      token: Symbol("external-thread-history-replacement"),
      mutationToken: mutation.token,
      nativeRef,
      session,
    };
    this.#historyReplacements.set(replacement.token, replacement);
    return replacement;
  }

  async discardHistoryReplacement(replacement: ExternalThreadHistoryReplacement): Promise<void> {
    const reserved = this.#historyReplacements.get(replacement.token);
    if (!reserved || reserved.threadId !== replacement.threadId) return;
    this.#historyReplacements.delete(replacement.token);
    await this.closeUnownedSession(reserved.session, reserved.nativeRef);
  }

  async prepareHistoryCommit(
    current: ExternalThread,
    mutation: ExternalThreadHistoryMutation,
    replacement: ExternalThreadHistoryReplacement,
  ): Promise<ExternalThreadRpcError | null> {
    if (current.session.capabilities.history.replacementFence !== true) {
      return {
        code: -32076,
        message: "External Harness cannot fence Native activity for history replacement",
      };
    }
    const active = current.historyMutation;
    const reserved = this.#historyReplacements.get(replacement.token);
    if (reserved?.session.capabilities.history.replacementFence !== true) {
      return {
        code: -32076,
        message: "External rollback candidate lost its history replacement fence",
      };
    }
    if (
      this.#threads.get(current.id) !== current ||
      active?.token !== mutation.token ||
      active.phase !== "deriving" ||
      active.invalidated ||
      mutation.threadId !== current.id ||
      replacement.threadId !== current.id ||
      reserved?.mutationToken !== mutation.token ||
      this.#hasSessionOwner(reserved.session, reserved.nativeRef, reserved.token) ||
      current.running ||
      current.activeTurnId !== null ||
      current.historyRefresh !== null ||
      current.outputProjections.size > 0 ||
      current.sessionAccesses.size > 0 ||
      this.#hasOtherSessionOwner(current) ||
      !this.#adapters.has(current.harnessId)
    ) {
      return { code: -32072, message: "External Thread became active" };
    }

    // `close()` is the public native-work fence. Rotate the mutation gate so an Output that was
    // already waiting in the deriving phase can drain without making the Thread callable again.
    // Once close and the single Output consumer have both settled, no old-session work can overlap
    // the asynchronous Mapping Store commit.
    active.phase = "fencing";
    active.sourceMustBeReloaded = true;
    const derivingResolve = active.resolve;
    const fencingGate = Promise.withResolvers<undefined>();
    active.promise = fencingGate.promise;
    active.resolve = fencingGate.resolve;
    derivingResolve(undefined);
    try {
      await current.session.close();
      await current.outputTask;
    } catch (error) {
      this.#diagnose(error);
      return { code: -32076, message: "External Thread could not stop Native activity" };
    }

    const currentActive = current.historyMutation;
    if (
      this.#threads.get(current.id) !== current ||
      currentActive?.token !== mutation.token ||
      currentActive.phase !== "fencing" ||
      currentActive.invalidated ||
      current.running ||
      current.activeTurnId !== null ||
      current.historyRefresh !== null ||
      current.outputProjections.size > 0 ||
      current.sessionAccesses.size > 0 ||
      mutation.threadId !== current.id ||
      replacement.threadId !== current.id ||
      reserved.mutationToken !== mutation.token ||
      this.#historyReplacements.get(replacement.token) !== reserved ||
      this.#hasSessionOwner(reserved.session, reserved.nativeRef, reserved.token) ||
      this.#hasOtherSessionOwner(current) ||
      !this.#adapters.has(current.harnessId)
    ) {
      return { code: -32072, message: "External Thread changed while Native activity stopped" };
    }
    currentActive.phase = "committing";
    return null;
  }

  assertHistoryReplacement(
    current: ExternalThread,
    mutation: ExternalThreadHistoryMutation,
    replacement: ExternalThreadHistoryReplacement,
  ): void {
    const active = current.historyMutation;
    const reserved = this.#historyReplacements.get(replacement.token);
    if (
      this.#threads.get(current.id) !== current ||
      active?.token !== mutation.token ||
      active.phase !== "committing" ||
      active.invalidated ||
      current.running ||
      current.activeTurnId !== null ||
      current.historyRefresh !== null ||
      current.outputProjections.size > 0 ||
      current.sessionAccesses.size > 0 ||
      mutation.threadId !== current.id ||
      replacement.threadId !== current.id ||
      reserved?.mutationToken !== mutation.token ||
      this.#hasSessionOwner(reserved.session, reserved.nativeRef, reserved.token) ||
      !this.#adapters.has(current.harnessId)
    ) {
      throw new Error("External Thread runtime cannot replace a stale or active Session");
    }
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
    mutation: ExternalThreadHistoryMutation,
    historyReplacement: ExternalThreadHistoryReplacement,
  ): Promise<ExternalThread> {
    this.assertHistoryReplacement(current, mutation, historyReplacement);
    if (input.record.hostThreadId !== current.id) {
      throw new Error("External Thread runtime cannot replace a stale or unreserved Session");
    }
    const reserved = this.#historyReplacements.get(historyReplacement.token);
    if (
      !reserved ||
      reserved.session !== input.session ||
      reserved.nativeRef.harnessId !== input.record.nativeSessionRef?.harnessId ||
      reserved.nativeRef.nativeSessionId !== input.record.nativeSessionRef.nativeSessionId
    ) {
      throw new Error("External Thread runtime received an unreserved replacement Session");
    }
    const activeMutation = current.historyMutation;
    if (!activeMutation) {
      throw new Error("External Thread runtime lost its history mutation reservation");
    }
    this.#historyReplacements.delete(historyReplacement.token);
    this.#threads.delete(current.id);
    let replacement: ExternalThread;
    try {
      replacement = this.register(input);
    } catch (error) {
      // The Store already owns the replacement identity and the old Session was fenced. Leave the
      // Runtime unloaded so the next request resumes the committed record instead of reviving the
      // closed source wrapper.
      await input.session.close().catch(() => undefined);
      throw error;
    }
    current.historyMutation = null;
    activeMutation.resolve(undefined);
    try {
      await current.session.close();
      await current.outputTask;
    } catch (error) {
      this.#diagnose(error);
    }
    return replacement;
  }

  async locate(threadId: string): Promise<ExternalThreadLocation> {
    return this.#resolver.locate(threadId);
  }

  async resolve(threadId: string): Promise<ExternalThreadResolution> {
    return this.#resolver.resolve(threadId);
  }

  async refresh(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
    const refresh = this.#beginHistoryRefresh(thread);
    if (!refresh) {
      return { code: -32072, message: "External Thread history is busy" };
    }
    let error: ExternalThreadRpcError | null = null;
    try {
      let snapshot: Awaited<ReturnType<HarnessSession["readSnapshot"]>> | null = null;
      try {
        snapshot = await thread.session.readSnapshot();
      } catch {
        error = { code: -32076, message: "External Thread history read failed" };
      }
      if (!snapshot) {
        // The thrown read has already been mapped to the stable Host error above.
      } else if (!snapshot.ok) {
        error = mapExternalThreadHarnessError(snapshot.error, "read");
      } else if (
        thread.historyRefresh?.token !== refresh.token ||
        thread.historyRefresh.pendingOutput
      ) {
        error = { code: -32072, message: "External Thread changed while history was read" };
      } else {
        try {
          const aligned = this.#repository.projectKnownSnapshot(thread.record, snapshot.value);
          if (!aligned) {
            error = { code: -32072, message: "External Thread has unprojected Native activity" };
          } else {
            thread.record = aligned.record;
            thread.turns = aligned.turns;
            thread.historyHydrated = true;
            thread.thread = externalThreadValue({
              record: aligned.record,
              turns: aligned.turns,
              sessionId: thread.sessionId,
              running: thread.running,
            });
          }
        } catch {
          error = { code: -32076, message: "External Thread history could not be projected" };
        }
      }
    } finally {
      if (this.#endHistoryRefresh(thread, refresh)) {
        error = { code: -32072, message: "External Thread changed while history was read" };
      }
    }
    return error;
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
}
