import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type {
  HarnessAdapter,
  HarnessModelRef,
  HarnessSession,
  HarnessSessionState,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";
import type { StoredDelegationRecordV1, StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  encodeExternalTransportSelection,
  transportModelIdForHarness,
  type ExternalHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
  type RoutedHarnessId,
} from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  type HarnessDelegationDefault,
} from "@codexhost/shared-contracts";

import {
  DELEGATION_THREAD_ID_ENV,
  DelegationControlError,
  type DelegationConfigurationResult,
  type DelegationPendingQuestion,
  type DelegationStartInput,
  type DelegationStartResult,
  type DelegationThreadListResult,
  type DelegationThreadSnapshot,
  type HarnessInspectInput,
  type HarnessInspectResult,
  type HarnessListResult,
  type ThreadCancelInput,
  type ThreadCancelResult,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadSendInput,
  type ThreadSendResult,
  type ThreadWaitInput,
} from "./delegation-types.js";
import {
  exportDelegationThread,
  validateThreadExportInput,
  type ThreadExportInput,
  type ThreadExportResult,
} from "./delegation-thread-export.js";
import { resolveDelegationConfiguration } from "./delegation-configuration.js";
import { resolveDelegationModelArgument } from "./delegation-model-argument.js";
import { normalizeStoredModelRef } from "./stored-model-ref.js";
import { originClientName } from "./external-client-origin.js";
import { delegationTitle } from "./delegation-title.js";
import { projectDelegationThreadSnapshot, validateReadOptions } from "./delegation-snapshot.js";
import {
  createExternalThreadRecordInput,
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";

const IMPLICIT_DEDUPLICATION_MS = 30_000;
const NATIVE_REF_TIMEOUT_MS = 10_000;

type ParentMetadata = { cwd?: string; title?: string };
type ReadDelegationDefault = (
  harnessId: RoutedHarnessId,
) => Promise<HarnessDelegationDefault | undefined>;
type ResolveOfficialConfiguration = (
  model: HarnessModelRef | undefined,
  inspected?: HarnessInspectResult,
) => ReturnType<typeof resolveDelegationConfiguration>;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function externalThreadError(
  error: ExternalThreadRpcError,
  details?: { notStarted: true },
): DelegationControlError {
  return new DelegationControlError("INTERNAL_ERROR", error.message, {
    externalThreadCode: error.code,
    ...details,
  });
}

function terminal(status: DelegationThreadSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function taskDigest(
  input: Pick<DelegationStartInput, "task" | "thinkingOptionId"> & {
    cwd: string;
    model: HarnessModelRef | undefined;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        task: input.task,
        cwd: path.resolve(input.cwd),
        model: input.model ? [input.model.id, input.model.serviceTier ?? null] : null,
        thinkingOptionId: input.thinkingOptionId ?? null,
      }),
    )
    .digest("hex");
}

function statusFromThread(
  thread: ExternalThread,
  busy: boolean,
): StoredDelegationRecordV1["status"] {
  if (busy) return "running";
  const last = thread.turns.at(-1);
  if (last?.status === "failed") return "failed";
  if (last?.status === "interrupted") return "interrupted";
  return last ? "completed" : "creating";
}

function validateStart(input: DelegationStartInput): void {
  if (typeof input.task !== "string" || !input.task.trim())
    throw new DelegationControlError("INVALID_ARGUMENT", "Task must not be empty");
  if (
    input.taskName !== undefined &&
    (typeof input.taskName !== "string" || !input.taskName.trim() || input.taskName.length > 120)
  ) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Task name must contain 1 to 120 characters",
    );
  }
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.trim()))
    throw new DelegationControlError("INVALID_ARGUMENT", "cwd must not be empty");
  if (
    input.requestId !== undefined &&
    (typeof input.requestId !== "string" || !input.requestId.trim())
  ) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Request ID must not be empty");
  }
}

export class HarnessDelegationCoordinator {
  readonly #adapters: Map<ExternalHarnessId, HarnessAdapter>;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #externalRuntime: ExternalThreadRuntime;
  readonly #repository: ExternalThreadRepository;
  readonly #registerExternalThread: (input: {
    record: StoredThreadRecordV1;
    session: HarnessSession;
    sessionId: string;
    thread: JsonObject;
    turns: JsonObject[];
    requestedModel?: HarnessModelRef;
    requestedThinkingOptionId?: HarnessThinkingOptionId;
    restoredState?: HarnessSessionState;
  }) => ExternalThread;
  readonly #startExternalTurn: (
    thread: ExternalThread,
    text: string,
    turnId: string,
  ) => Promise<void>;
  readonly #steerExternalTurn: (thread: ExternalThread, text: string) => Promise<string>;
  readonly #notifyThreadStarted: (thread: JsonObject) => Promise<void>;
  readonly #notifyTreeChanged: (threadId: string) => void;
  readonly #readDelegationDefault: ReadDelegationDefault | undefined;
  readonly #inspectOfficial: (input: HarnessInspectInput) => Promise<HarnessInspectResult>;
  readonly #readOfficial: (input: ThreadReadInput) => Promise<DelegationThreadSnapshot>;
  readonly #exportOfficial: ((input: ThreadExportInput) => Promise<ThreadExportResult>) | undefined;
  readonly #sendOfficial: (input: ThreadSendInput) => Promise<ThreadSendResult>;
  readonly #cancelOfficial: (input: ThreadCancelInput) => Promise<ThreadCancelResult>;
  readonly #startOfficial: (
    input: DelegationStartInput & { parentThreadId: string; cwd: string; title: string },
    resolveConfiguration: ResolveOfficialConfiguration,
  ) => Promise<DelegationStartResult>;
  readonly #listOfficial: (input: ThreadListInput) => Promise<DelegationThreadListResult>;
  readonly #officialThreadMetadata: (threadId: string) => Promise<ParentMetadata>;
  readonly #activeOfficialParents: () => string[];
  readonly #externalThreadBusy: (thread: ExternalThread) => boolean;
  readonly #pendingQuestions: (threadId: string) => DelegationPendingQuestion[];

  constructor(input: {
    adapters: Map<ExternalHarnessId, HarnessAdapter>;
    environment: NodeJS.ProcessEnv;
    externalRuntime: ExternalThreadRuntime;
    repository: ExternalThreadRepository;
    registerExternalThread(input: {
      record: StoredThreadRecordV1;
      session: HarnessSession;
      sessionId: string;
      thread: JsonObject;
      turns: JsonObject[];
      requestedModel?: HarnessModelRef;
      requestedThinkingOptionId?: HarnessThinkingOptionId;
      restoredState?: HarnessSessionState;
    }): ExternalThread;
    startExternalTurn(thread: ExternalThread, text: string, turnId: string): Promise<void>;
    steerExternalTurn(thread: ExternalThread, text: string): Promise<string>;
    notifyThreadStarted(thread: JsonObject): Promise<void>;
    notifyTreeChanged(threadId: string): void;
    readDelegationDefault?: ReadDelegationDefault;
    inspectOfficial(input: HarnessInspectInput): Promise<HarnessInspectResult>;
    readOfficial(input: ThreadReadInput): Promise<DelegationThreadSnapshot>;
    exportOfficial?(input: ThreadExportInput): Promise<ThreadExportResult>;
    sendOfficial(input: ThreadSendInput): Promise<ThreadSendResult>;
    cancelOfficial(input: ThreadCancelInput): Promise<ThreadCancelResult>;
    startOfficial(
      input: DelegationStartInput & { parentThreadId: string; cwd: string; title: string },
      resolveConfiguration: ResolveOfficialConfiguration,
    ): Promise<DelegationStartResult>;
    listOfficial(input: ThreadListInput): Promise<DelegationThreadListResult>;
    officialThreadMetadata(threadId: string): Promise<ParentMetadata>;
    activeOfficialParents(): string[];
    externalThreadBusy(thread: ExternalThread): boolean;
    pendingQuestions(threadId: string): DelegationPendingQuestion[];
  }) {
    this.#adapters = input.adapters;
    this.#environment = input.environment;
    this.#externalRuntime = input.externalRuntime;
    this.#repository = input.repository;
    this.#registerExternalThread = input.registerExternalThread;
    this.#startExternalTurn = input.startExternalTurn;
    this.#steerExternalTurn = input.steerExternalTurn;
    this.#notifyThreadStarted = input.notifyThreadStarted;
    this.#notifyTreeChanged = input.notifyTreeChanged;
    this.#readDelegationDefault = input.readDelegationDefault;
    this.#inspectOfficial = input.inspectOfficial;
    this.#readOfficial = input.readOfficial;
    this.#exportOfficial = input.exportOfficial;
    this.#sendOfficial = input.sendOfficial;
    this.#cancelOfficial = input.cancelOfficial;
    this.#startOfficial = input.startOfficial;
    this.#listOfficial = input.listOfficial;
    this.#officialThreadMetadata = input.officialThreadMetadata;
    this.#activeOfficialParents = input.activeOfficialParents;
    this.#externalThreadBusy = input.externalThreadBusy;
    this.#pendingQuestions = input.pendingQuestions;
  }

  async listHarnesses(): Promise<HarnessListResult> {
    return { harnesses: ["codex", ...this.#adapters.keys()] };
  }

  async inspect(input: HarnessInspectInput): Promise<HarnessInspectResult> {
    if (input.harnessId === "codex") return this.#inspectOfficial(input);
    const adapter = this.#adapters.get(input.harnessId as ExternalHarnessId);
    if (!adapter) {
      throw new DelegationControlError(
        "HARNESS_NOT_FOUND",
        `Harness '${input.harnessId}' is unavailable`,
        { validHarnessIds: ["codex", ...this.#adapters.keys()] },
      );
    }
    return {
      harnessId: input.harnessId,
      inspection: await adapter.inspect({
        ...(input.cwd ? { cwd: path.resolve(input.cwd) } : {}),
        ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
        ...(input.credentialAccess === "allow" || input.credentialAccess === "retry"
          ? { credentialAccess: input.credentialAccess }
          : {}),
      }),
    };
  }

  async start(input: DelegationStartInput): Promise<DelegationStartResult> {
    validateStart(input);
    // An external client has no workspace of its own for the child to inherit.
    if (originClientName(input.parentThreadId) && !input.cwd)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "--cwd is required when an external client starts work without a parent Thread",
      );
    const parentThreadId = await this.#resolveParent(input.parentThreadId);
    const parent = await this.#parentMetadata(parentThreadId);
    const selectedCwd = input.cwd ?? parent.cwd ?? process.cwd();
    const title = delegationTitle(input);
    if (input.harnessId === "codex") {
      const startInput = { ...input, parentThreadId, cwd: selectedCwd, title };
      // The official owner resolves preferences only after checking the original request digest.
      const result = await this.#startOfficial(startInput, (model, inspected) =>
        this.#resolveConfiguration(startInput, model, inspected && Promise.resolve(inspected)),
      );
      return {
        ...result,
        parentThreadId,
        cwd: result.cwd ?? selectedCwd,
        title: result.title ?? title,
      };
    }
    const targetHarnessId = input.harnessId;
    const adapter = this.#adapters.get(targetHarnessId);
    if (!adapter) {
      throw new DelegationControlError(
        "HARNESS_NOT_FOUND",
        `Harness '${input.harnessId}' is unavailable`,
        { validHarnessIds: ["codex", ...this.#adapters.keys()] },
      );
    }
    const startInput = { ...input, parentThreadId, cwd: path.resolve(selectedCwd) };
    const inspection = input.model !== undefined ? this.inspect(startInput) : undefined;
    const inspected = await inspection?.catch(() => undefined);
    const catalog =
      inspected?.inspection.status === "ready" ? inspected.inspection.catalog : undefined;
    const explicitModel =
      input.model === undefined
        ? undefined
        : await resolveDelegationModelArgument(input.model, async () => catalog);
    const modelForRequest = explicitModel
      ? ((await normalizeStoredModelRef(explicitModel, catalog, targetHarnessId, adapter)) ??
        explicitModel)
      : undefined;
    const digest = taskDigest({ ...startInput, model: modelForRequest });
    const duplicate = input.requestId
      ? await this.#repository.findDelegationByRequest(input.requestId)
      : await this.#repository.findRecentDelegation({
          parentHostThreadId: hostThreadIdSchema.parse(parentThreadId),
          targetHarnessId: harnessIdSchema.parse(targetHarnessId),
          taskDigest: digest,
          since: new Date(Date.now() - IMPLICIT_DEDUPLICATION_MS),
        });
    if (
      duplicate &&
      input.requestId &&
      (duplicate.targetHarnessId !== targetHarnessId || duplicate.taskDigest !== digest)
    ) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Request ID is already associated with another Delegation configuration",
      );
    }
    if (duplicate) return this.#existingResult(duplicate);

    const selection = await this.#resolveConfiguration(startInput, modelForRequest, inspection);
    const { model, thinkingOptionId } = selection;
    const transportModelId =
      model || thinkingOptionId
        ? encodeExternalTransportSelection(targetHarnessId, selection)
        : transportModelIdForHarness(targetHarnessId);
    const delegationId = hostThreadIdSchema.parse(randomUUID());
    const childThreadId = hostThreadIdSchema.parse(randomUUID());
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const createRequestId = input.requestId ? `delegation:${input.requestId}` : randomUUID();
    let record = await this.#repository.createProvisional(
      createExternalThreadRecordInput({
        hostThreadId: childThreadId,
        createRequestId,
        harnessId: harnessIdSchema.parse(targetHarnessId),
        cwd: startInput.cwd,
        title,
        transportModelId,
        ephemeral: false,
        historyMode: "paginated",
      }),
    );
    let delegation: StoredDelegationRecordV1 | null = null;
    let session: HarnessSession | null = null;
    return this.#externalRuntime.idleRelease.runOperation(childThreadId, async () => {
      try {
        delegation = await this.#repository.createDelegation({
          delegationId,
          parentHostThreadId: hostThreadIdSchema.parse(parentThreadId),
          childHostThreadId: childThreadId,
          sourceHarnessId: harnessIdSchema.parse(parent.harnessId),
          targetHarnessId: harnessIdSchema.parse(targetHarnessId),
          status: "creating",
          ...(input.requestId ? { requestId: input.requestId } : {}),
          taskDigest: digest,
        });
        this.#notifyTreeChanged(childThreadId);
        const opened = await adapter.open({
          kind: "create",
          cwd: record.cwd,
          environment: { ...this.#environment, [DELEGATION_THREAD_ID_ENV]: childThreadId },
          executionPolicy: "unattended-full-access",
          ...selection,
        });
        if (!opened.ok) throw new DelegationControlError("DELEGATION_FAILED", opened.error.message);
        session = opened.value;
        if (session.initialState.nativeRef) {
          record = await this.#repository.commitNative(
            record.hostThreadId,
            session.initialState.nativeRef,
          );
        }
        const threadValue = externalThreadValue({
          record,
          turns: [],
          sessionId: record.hostThreadId,
          running: true,
        });
        const thread = this.#registerExternalThread({
          record,
          session,
          sessionId: record.hostThreadId,
          thread: threadValue,
          turns: [],
          ...(model ? { requestedModel: model } : {}),
          ...(thinkingOptionId ? { requestedThinkingOptionId: thinkingOptionId } : {}),
          ...(session.initialState.nativeRef ? {} : { restoredState: session.initialState }),
        });
        const beforeRevision = thread.stateObserver.revision;
        await this.#startExternalTurn(thread, input.task, turnId);
        if (!thread.record.nativeSessionRef) {
          const deadline = Date.now() + NATIVE_REF_TIMEOUT_MS;
          let revision = beforeRevision;
          while (!thread.record.nativeSessionRef) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              throw new Error("Target Harness Native Session identity was not persisted");
            }
            await thread.stateObserver.waitForChange(revision, remaining);
            revision = thread.stateObserver.revision;
          }
        }
        const state = thread.stateObserver.state;
        if (state.effectiveModel && state.effectivePermissionModeId) {
          const transportModelId = encodeExternalTransportSelection(targetHarnessId, {
            model: state.effectiveModel,
            permissionModeId: state.effectivePermissionModeId,
            ...(state.effectiveThinkingOptionId
              ? { thinkingOptionId: state.effectiveThinkingOptionId }
              : {}),
          });
          thread.record = await this.#repository.setTransportModelId(
            childThreadId,
            transportModelId,
          );
          thread.transportModelId = transportModelId;
          thread.requestedPermissionModeId = state.effectivePermissionModeId;
          thread.thread = externalThreadValue({
            record: thread.record,
            turns: thread.turns,
            sessionId: thread.sessionId,
            running: thread.running,
          });
        }
        await this.#repository.setDelegationStatus(delegationId, "running");
        await this.#notifyThreadStarted(thread.thread);
        return {
          ...this.#result(delegationId, childThreadId, turnId, targetHarnessId, "running", {
            requested: selection,
            effective: {
              ...(thread.stateObserver.state.effectiveModel
                ? { effectiveModel: thread.stateObserver.state.effectiveModel }
                : {}),
              ...(thread.stateObserver.state.resolvedModelLabel
                ? { resolvedModelLabel: thread.stateObserver.state.resolvedModelLabel }
                : {}),
              ...(thread.stateObserver.state.effectiveThinkingOptionId
                ? {
                    effectiveThinkingOptionId: thread.stateObserver.state.effectiveThinkingOptionId,
                  }
                : {}),
            },
          }),
          cwd: record.cwd,
          title: record.title,
          parentThreadId,
        };
      } catch (error) {
        if (session) await session.close().catch(() => undefined);
        this.#externalRuntime.remove(childThreadId);
        if (delegation)
          await this.#repository.removeDelegation(delegation.delegationId).catch(() => undefined);
        await this.#repository.removeThread(childThreadId).catch(() => undefined);
        if (error instanceof DelegationControlError) throw error;
        throw new DelegationControlError(
          "DELEGATION_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }

  async send(input: ThreadSendInput): Promise<ThreadSendResult> {
    return this.#externalRuntime.idleRelease.runOperation(input.threadId, () => this.#send(input));
  }

  async #send(input: ThreadSendInput): Promise<ThreadSendResult> {
    if (!input.message?.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Message must not be empty");
    }
    const location = await this.#externalRuntime.locate(input.threadId);
    if (location.kind === "official") return this.#sendOfficial(input);
    if (location.kind === "error") throw externalThreadError(location.error, { notStarted: true });
    const { thread } = await this.#resolveExternalThread(input.threadId, { notStarted: true });
    if (thread.record.subagent) {
      throw new DelegationControlError("DELEGATION_FAILED", "Thread is read-only", {
        readOnly: true,
      });
    }
    if (this.#externalThreadBusy(thread) || thread.activeTurnId) {
      if (!input.steer) {
        throw new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");
      }
      const turnId = await this.#steerExternalTurn(thread, input.message);
      return this.#turnResult(thread.id, turnId, thread.harnessId);
    }
    const turnId = hostTurnIdSchema.parse(randomUUID());
    try {
      await this.#startExternalTurn(thread, input.message, turnId);
    } catch (error) {
      if (error instanceof DelegationControlError) throw error;
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
    return this.#turnResult(thread.id, turnId, thread.harnessId);
  }

  async cancel(input: ThreadCancelInput): Promise<ThreadCancelResult> {
    return this.#externalRuntime.idleRelease.runOperation(input.threadId, () =>
      this.#cancel(input),
    );
  }

  async #cancel(input: ThreadCancelInput): Promise<ThreadCancelResult> {
    const location = await this.#externalRuntime.locate(input.threadId);
    if (location.kind === "official") return this.#cancelOfficial(input);
    if (location.kind === "error") throw externalThreadError(location.error);
    const { thread } = await this.#resolveExternalThread(input.threadId);
    if (thread.record.subagent) {
      throw new DelegationControlError("DELEGATION_FAILED", "Thread is read-only");
    }
    const turnId = thread.activeTurnId;
    if (!thread.running || !turnId) {
      return { threadId: thread.id, turnId: null, harnessId: thread.harnessId, cancelled: false };
    }
    const result = await thread.session.execute({ type: "turn.cancel", turnId });
    if (!result.ok) {
      throw new DelegationControlError("DELEGATION_FAILED", result.error.message);
    }
    return { threadId: thread.id, turnId, harnessId: thread.harnessId, cancelled: true };
  }

  async read(input: ThreadReadInput): Promise<DelegationThreadSnapshot> {
    return this.#externalRuntime.idleRelease.runOperation(input.threadId, () => this.#read(input));
  }

  async #read(input: ThreadReadInput): Promise<DelegationThreadSnapshot> {
    validateReadOptions(input);
    const location = await this.#externalRuntime.locate(input.threadId);
    if (location.kind === "official") {
      return this.#withPendingQuestions(await this.#readOfficial(input), input.threadId);
    }
    if (location.kind === "error") throw externalThreadError(location.error);
    const source = await this.#readExternalThread(input.threadId).catch(async (error: unknown) => {
      if (!(error instanceof DelegationControlError) || error.code !== "INTERNAL_ERROR")
        throw error;
      const retained = await this.#externalRuntime.retainedFailure(input.threadId);
      if (!retained) throw error;
      return retained;
    });
    if ("record" in source) {
      return this.#withPendingQuestions(
        projectDelegationThreadSnapshot({
          ...input,
          thread: {
            cwd: source.record.cwd,
            name: source.record.title,
            preview: source.record.preview ?? "",
          },
          harnessId: source.record.harnessId as RoutedHarnessId,
          turns: source.turns,
          running: false,
        }),
        input.threadId,
      );
    }
    const { thread, turns, busy } = source;
    const snapshot = projectDelegationThreadSnapshot({
      threadId: thread.id,
      harnessId: thread.harnessId,
      thread: thread.thread,
      turns,
      running: busy,
      view: input.view,
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
    });
    const delegation = await this.#repository.getDelegationByChild(
      hostThreadIdSchema.parse(thread.id),
    );
    const status = statusFromThread(thread, busy);
    if (delegation && delegation.status !== status) {
      await this.#repository.setDelegationStatus(delegation.delegationId, status);
    }
    return this.#withPendingQuestions(snapshot, thread.id);
  }

  async exportThread(input: ThreadExportInput): Promise<ThreadExportResult> {
    validateThreadExportInput(input);
    return this.#externalRuntime.idleRelease.runOperation(input.threadId, async () => {
      const location = await this.#externalRuntime.locate(input.threadId);
      if (location.kind === "official") {
        if (!this.#exportOfficial)
          throw new DelegationControlError("UNSUPPORTED", "Thread export is unavailable");
        return this.#exportOfficial(input);
      }
      if (location.kind === "error") throw externalThreadError(location.error);
      const { thread, turns, busy } = await this.#readExternalThread(input.threadId, true);
      return exportDelegationThread(
        input,
        {
          threadId: thread.id,
          harnessId: thread.harnessId,
          thread: thread.thread,
          turns,
          running: busy,
        },
        this.#environment,
      );
    });
  }

  async #resolveExternalThread(threadId: string, details?: { notStarted: true }) {
    const resolution = await this.#externalRuntime.resolve(threadId);
    if (resolution.kind === "error") throw externalThreadError(resolution.error, details);
    if (resolution.kind === "official") {
      // We already located an external mapping; it disappeared before resolution.
      throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    }
    return resolution;
  }

  async #readExternalThread(threadId: string, includeLiveItems = false) {
    const { thread, historyFresh } = await this.#resolveExternalThread(threadId);
    if (!this.#externalThreadBusy(thread) && !historyFresh) {
      const error = await this.#externalRuntime.refresh(thread);
      if (error?.code === -32075) throw externalThreadError(error);
      // A Harness that died cannot serve its native history, but the Host already
      // projected the terminal Turn. Report that Turn only while it is still the
      // latest attempt, so an older Turn never stands in for a later start.
      const last = thread.turns.at(-1);
      const projectedTerminal =
        thread.projectedTerminalTurnId !== null &&
        last?.id === thread.projectedTerminalTurnId &&
        (last.status === "completed" || last.status === "failed" || last.status === "interrupted");
      if (error && !projectedTerminal) throw externalThreadError(error);
    }
    const projector = thread.activeTurnId
      ? thread.projectedTurns.get(thread.activeTurnId)?.projector
      : undefined;
    const turns = thread.activeTurnId
      ? [
          ...thread.turns,
          (includeLiveItems ? projector?.snapshotTurn() : projector?.pendingTurn()) ?? {},
        ]
      : thread.turns;
    return { thread, turns, busy: this.#externalThreadBusy(thread) };
  }

  /**
   * Questions come from the owning Host session's single pending-Question state,
   * so `thread read` reports them whether the Thread is external or native.
   */
  #withPendingQuestions(
    snapshot: DelegationThreadSnapshot,
    threadId: string,
  ): DelegationThreadSnapshot {
    return { ...snapshot, pendingQuestions: this.#pendingQuestions(threadId) };
  }

  async wait(input: ThreadWaitInput): Promise<DelegationThreadSnapshot & { timedOut: boolean }> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new DelegationControlError("INVALID_ARGUMENT", "timeoutMs must be a positive integer");
    }
    const deadline = Date.now() + input.timeoutMs;
    while (true) {
      const snapshot = await this.read(input);
      // Questions are ready conditions even when an async question lets the
      // native Turn continue working without its answer.
      if (terminal(snapshot.status) || snapshot.pendingQuestions?.length) {
        return { ...snapshot, timedOut: false };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...snapshot, timedOut: true };
      await delay(Math.min(100, remaining));
    }
  }

  async list(input: ThreadListInput): Promise<DelegationThreadListResult> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 100) {
      throw new DelegationControlError("INVALID_ARGUMENT", "List limit must be between 1 and 100");
    }
    if (!input.parentThreadId) return this.#listOfficial(input);
    const parent = hostThreadIdSchema.parse(input.parentThreadId);
    const delegations = await this.#repository.listDelegations(parent);
    const records = await this.#repository.list();
    const byId = new Map(records.map((record) => [record.hostThreadId, record] as const));
    const rows = delegations.map((delegation) => {
      const record = byId.get(delegation.childHostThreadId);
      return {
        threadId: delegation.childHostThreadId,
        harnessId: delegation.targetHarnessId as RoutedHarnessId,
        deepLink: `codex://threads/${delegation.childHostThreadId}`,
        status: delegation.status,
        ...(record
          ? {
              cwd: record.cwd,
              title: record.title,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            }
          : {
              createdAt: delegation.createdAt,
              updatedAt: delegation.updatedAt,
            }),
      };
    });
    const [field, direction] = input.sort.split("-") as [
      "created" | "updated" | "recency",
      "asc" | "desc",
    ];
    rows.sort((left, right) => {
      const leftTimestamp = field === "created" ? left.createdAt : left.updatedAt;
      const rightTimestamp = field === "created" ? right.createdAt : right.updatedAt;
      const leftTime = Date.parse(leftTimestamp ?? "");
      const rightTime = Date.parse(rightTimestamp ?? "");
      return direction === "asc" ? leftTime - rightTime : rightTime - leftTime;
    });
    let offset = 0;
    if (input.cursor) {
      try {
        const decoded = Buffer.from(input.cursor, "base64url").toString("utf8");
        if (Buffer.from(decoded).toString("base64url") !== input.cursor) throw new Error();
        offset = Number(decoded);
      } catch {
        throw new DelegationControlError("INVALID_ARGUMENT", "List cursor is invalid");
      }
    }
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new DelegationControlError("INVALID_ARGUMENT", "List cursor is invalid");
    const page = rows.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    return {
      threads: page,
      nextCursor:
        nextOffset < rows.length ? Buffer.from(String(nextOffset)).toString("base64url") : null,
    };
  }

  /** External and native Codex Threads that currently have an active Turn. */
  activeThreadIds(): string[] {
    const external = this.#externalRuntime
      .values()
      .filter((thread) => this.#externalThreadBusy(thread))
      .map((thread) => thread.id);
    return [...external, ...this.#activeOfficialParents()];
  }

  async #resolveParent(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    const environmentThreadId = this.#environment[DELEGATION_THREAD_ID_ENV];
    if (environmentThreadId) return environmentThreadId;
    const active = this.activeThreadIds();
    const onlyActive = active.length === 1 ? active[0] : undefined;
    if (onlyActive) return onlyActive;
    throw new DelegationControlError(
      "PARENT_THREAD_AMBIGUOUS",
      active.length === 0
        ? "Parent Thread cannot be inferred because no active Turn was found"
        : "Parent Thread cannot be inferred uniquely; pass --parent-thread explicitly",
      { activeThreadIds: active },
    );
  }

  #resolveConfiguration(
    { harnessId, cwd, thinkingOptionId }: DelegationStartInput & { cwd: string },
    model: HarnessModelRef | undefined,
    inspection?: Promise<HarnessInspectResult>,
  ) {
    return resolveDelegationConfiguration({
      harnessId,
      adapter: this.#adapters.get(harnessId),
      explicit: { model, thinkingOptionId },
      readDefault: async () => this.#readDelegationDefault?.(harnessId),
      inspect: () => inspection ?? this.inspect({ harnessId, cwd }),
    });
  }

  async #parentMetadata(
    parentThreadId: string,
  ): Promise<ParentMetadata & { harnessId: RoutedHarnessId }> {
    // A client origin is no Thread; its stored source Harness keeps the native default.
    const client = originClientName(parentThreadId);
    if (client) return { harnessId: "codex", title: client };
    const record = await this.#repository.find(parentThreadId);
    if (record)
      return {
        harnessId: record.harnessId as RoutedHarnessId,
        cwd: record.cwd,
        title: record.title.trim() || record.preview || "",
      };
    const metadata = await this.#officialThreadMetadata(parentThreadId).catch(() => ({}));
    return { harnessId: "codex", ...metadata };
  }

  async #existingResult(delegation: StoredDelegationRecordV1): Promise<DelegationStartResult> {
    const record = await this.#repository.find(delegation.childHostThreadId);
    const turnId = record?.turnMappings.at(-1)?.hostTurnId ?? "pending";
    return {
      ...this.#result(
        delegation.delegationId,
        delegation.childHostThreadId,
        turnId,
        delegation.targetHarnessId as RoutedHarnessId,
        delegation.status,
      ),
      ...(record ? { cwd: record.cwd, title: record.title } : {}),
      parentThreadId: delegation.parentHostThreadId,
    };
  }

  #turnResult(threadId: string, turnId: string, harnessId: RoutedHarnessId): ThreadSendResult {
    return {
      threadId,
      turnId,
      harnessId,
      status: "running",
      next: {
        read: `codexhost thread read ${threadId}`,
        wait: `codexhost thread wait ${threadId} --timeout-ms 30000`,
      },
    };
  }

  #result(
    delegationId: string,
    threadId: string,
    turnId: string,
    harnessId: RoutedHarnessId,
    status: DelegationStartResult["status"],
    configuration?: DelegationConfigurationResult,
  ): DelegationStartResult {
    return {
      delegationId,
      threadId,
      turnId,
      harnessId,
      deepLink: `codex://threads/${threadId}`,
      status,
      ...(configuration &&
      (Object.keys(configuration.requested ?? {}).length > 0 ||
        Object.keys(configuration.effective ?? {}).length > 0)
        ? { configuration }
        : {}),
      next: {
        read: `codexhost thread read ${threadId}`,
        wait: `codexhost thread wait ${threadId} --timeout-ms 30000`,
      },
    };
  }
}
