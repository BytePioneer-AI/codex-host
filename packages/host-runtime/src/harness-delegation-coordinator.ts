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
  EXTERNAL_HARNESS_IDS,
  transportModelIdForHarness,
  type ExternalHarnessId,
  type JsonObject,
  type RoutedHarnessId,
} from "@codexhost/protocol-core";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  DELEGATION_THREAD_ID_ENV,
  DelegationControlError,
  type DelegationExecutionPolicy,
  type DelegationConfigurationResult,
  type DelegationStartInput,
  type DelegationStartResult,
  type DelegationThreadListResult,
  type DelegationThreadSnapshot,
  type HarnessInspectInput,
  type HarnessInspectResult,
  type ThreadCancelInput,
  type ThreadCancelResult,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadSendInput,
  type ThreadSendResult,
  type ThreadWaitInput,
} from "./delegation-types.js";
import { projectDelegationThreadSnapshot, validateReadOptions } from "./delegation-snapshot.js";
import {
  createExternalThreadRecordInput,
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";

const IMPLICIT_DEDUPLICATION_MS = 30_000;
const NATIVE_REF_TIMEOUT_MS = 10_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function terminal(status: DelegationThreadSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function taskDigest(
  input: Pick<DelegationStartInput, "task" | "cwd" | "model" | "thinkingOptionId"> & {
    executionPolicy: DelegationExecutionPolicy;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        task: input.task,
        cwd: path.resolve(input.cwd),
        modelId: input.model?.id ?? null,
        thinkingOptionId: input.thinkingOptionId ?? null,
        executionPolicy: input.executionPolicy,
      }),
    )
    .digest("hex");
}

function statusFromThread(thread: ExternalThread): StoredDelegationRecordV1["status"] {
  if (thread.running) return "running";
  const last = thread.turns.at(-1);
  if (last?.status === "failed") return "failed";
  if (last?.status === "interrupted") return "interrupted";
  return last ? "completed" : "creating";
}

function validateStart(input: DelegationStartInput): void {
  if (!input.task?.trim())
    throw new DelegationControlError("INVALID_ARGUMENT", "Task must not be empty");
  if (!input.cwd?.trim())
    throw new DelegationControlError("INVALID_ARGUMENT", "cwd must not be empty");
  if (input.requestId !== undefined && !input.requestId.trim()) {
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
  readonly #notifyThreadStarted: (thread: JsonObject) => Promise<void>;
  readonly #inspectOfficial: (input: HarnessInspectInput) => Promise<HarnessInspectResult>;
  readonly #readOfficial: (input: ThreadReadInput) => Promise<DelegationThreadSnapshot>;
  readonly #sendOfficial: (input: ThreadSendInput) => Promise<ThreadSendResult>;
  readonly #cancelOfficial: (input: ThreadCancelInput) => Promise<ThreadCancelResult>;
  readonly #startOfficial: (
    input: DelegationStartInput & { parentThreadId: string },
  ) => Promise<DelegationStartResult>;
  readonly #listOfficial: (input: ThreadListInput) => Promise<DelegationThreadListResult>;
  readonly #activeOfficialParents: () => string[];
  #startTail: Promise<void> = Promise.resolve();

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
    notifyThreadStarted(thread: JsonObject): Promise<void>;
    inspectOfficial(input: HarnessInspectInput): Promise<HarnessInspectResult>;
    readOfficial(input: ThreadReadInput): Promise<DelegationThreadSnapshot>;
    sendOfficial(input: ThreadSendInput): Promise<ThreadSendResult>;
    cancelOfficial(input: ThreadCancelInput): Promise<ThreadCancelResult>;
    startOfficial(
      input: DelegationStartInput & { parentThreadId: string },
    ): Promise<DelegationStartResult>;
    listOfficial(input: ThreadListInput): Promise<DelegationThreadListResult>;
    activeOfficialParents(): string[];
  }) {
    this.#adapters = input.adapters;
    this.#environment = input.environment;
    this.#externalRuntime = input.externalRuntime;
    this.#repository = input.repository;
    this.#registerExternalThread = input.registerExternalThread;
    this.#startExternalTurn = input.startExternalTurn;
    this.#notifyThreadStarted = input.notifyThreadStarted;
    this.#inspectOfficial = input.inspectOfficial;
    this.#readOfficial = input.readOfficial;
    this.#sendOfficial = input.sendOfficial;
    this.#cancelOfficial = input.cancelOfficial;
    this.#startOfficial = input.startOfficial;
    this.#listOfficial = input.listOfficial;
    this.#activeOfficialParents = input.activeOfficialParents;
  }

  async inspect(input: HarnessInspectInput): Promise<HarnessInspectResult> {
    if (input.harnessId === "codex") return this.#inspectOfficial(input);
    if (!EXTERNAL_HARNESS_IDS.includes(input.harnessId as ExternalHarnessId)) {
      throw new DelegationControlError(
        "HARNESS_NOT_FOUND",
        `Harness '${input.harnessId}' is unavailable`,
        { validHarnessIds: ["codex", ...EXTERNAL_HARNESS_IDS] },
      );
    }
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
      }),
    };
  }

  async start(input: DelegationStartInput): Promise<DelegationStartResult> {
    const result = this.#startTail.then(() => this.#start(input));
    this.#startTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #start(input: DelegationStartInput): Promise<DelegationStartResult> {
    validateStart(input);
    const executionPolicy = input.executionPolicy ?? "approval-required";
    const normalizedInput = { ...input, executionPolicy };
    const parentThreadId = await this.#resolveParent(input.parentThreadId);
    if (input.harnessId === "codex")
      return this.#startOfficial({ ...normalizedInput, parentThreadId });
    if (!EXTERNAL_HARNESS_IDS.includes(input.harnessId as ExternalHarnessId)) {
      throw new DelegationControlError(
        "HARNESS_NOT_FOUND",
        `Harness '${input.harnessId}' is unavailable`,
        {
          validHarnessIds: ["codex", ...EXTERNAL_HARNESS_IDS],
        },
      );
    }
    const targetHarnessId = input.harnessId as ExternalHarnessId;
    const digest = taskDigest(normalizedInput);
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

    const adapter = this.#adapters.get(targetHarnessId);
    if (!adapter) {
      throw new DelegationControlError(
        "HARNESS_NOT_FOUND",
        `Harness '${targetHarnessId}' is unavailable`,
        {
          validHarnessIds: ["codex", ...this.#adapters.keys()],
        },
      );
    }
    if (input.model || input.thinkingOptionId) {
      const inspected = await this.inspect({
        harnessId: targetHarnessId,
        cwd: input.cwd,
      });
      this.#validateConfiguration(inspected.inspection, input.model, input.thinkingOptionId);
    }
    const parent = await this.#parentMetadata(parentThreadId);
    const delegationId = hostThreadIdSchema.parse(randomUUID());
    const childThreadId = hostThreadIdSchema.parse(randomUUID());
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const createRequestId = input.requestId ? `delegation:${input.requestId}` : randomUUID();
    let record: StoredThreadRecordV1;
    let delegation: StoredDelegationRecordV1 | null = null;
    let session: HarnessSession | null = null;
    try {
      record = await this.#repository.createProvisional(
        createExternalThreadRecordInput({
          hostThreadId: childThreadId,
          createRequestId,
          harnessId: harnessIdSchema.parse(targetHarnessId),
          cwd: path.resolve(input.cwd),
          title: input.task.trim().slice(0, 120),
          transportModelId:
            input.model || input.thinkingOptionId
              ? encodeExternalTransportSelection(targetHarnessId, {
                  ...(input.model ? { model: input.model } : {}),
                  ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
                })
              : transportModelIdForHarness(targetHarnessId),
          ephemeral: false,
          historyMode: "paginated",
        }),
      );
      delegation = await this.#repository.createDelegation({
        delegationId,
        parentHostThreadId: hostThreadIdSchema.parse(parentThreadId),
        childHostThreadId: childThreadId,
        sourceHarnessId: harnessIdSchema.parse(parent.harnessId),
        targetHarnessId: harnessIdSchema.parse(targetHarnessId),
        status: "creating",
        executionPolicy,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        taskDigest: digest,
      });
      const opened = await adapter.open({
        kind: "create",
        cwd: record.cwd,
        environment: { ...this.#environment, [DELEGATION_THREAD_ID_ENV]: childThreadId },
        executionPolicy,
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
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
        ...(input.model ? { requestedModel: input.model } : {}),
        ...(input.thinkingOptionId ? { requestedThinkingOptionId: input.thinkingOptionId } : {}),
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
      await this.#repository.setDelegationStatus(delegationId, "running");
      await this.#notifyThreadStarted(thread.thread);
      return this.#result(delegationId, childThreadId, turnId, targetHarnessId, "running", {
        requested: {
          executionPolicy,
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
        },
        effective: {
          ...(thread.stateObserver.state.effectiveModel
            ? { effectiveModel: thread.stateObserver.state.effectiveModel }
            : {}),
          ...(thread.stateObserver.state.resolvedModelLabel
            ? { resolvedModelLabel: thread.stateObserver.state.resolvedModelLabel }
            : {}),
          ...(thread.stateObserver.state.effectiveThinkingOptionId
            ? { effectiveThinkingOptionId: thread.stateObserver.state.effectiveThinkingOptionId }
            : {}),
        },
      });
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
  }

  async send(input: ThreadSendInput): Promise<ThreadSendResult> {
    if (!input.message?.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Message must not be empty");
    }
    const location = await this.#externalRuntime.locate(input.threadId);
    if (location.kind === "official") return this.#sendOfficial(input);
    if (location.kind === "error") {
      throw new DelegationControlError("THREAD_NOT_FOUND", location.error.message);
    }
    const resolution = await this.#externalRuntime.resolve(input.threadId);
    if (resolution.kind !== "external") {
      throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    }
    const thread = resolution.thread;
    if (thread.record.subagent) {
      throw new DelegationControlError("DELEGATION_FAILED", "Thread is read-only");
    }
    if (thread.running || thread.activeTurnId) {
      throw new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");
    }
    const turnId = hostTurnIdSchema.parse(randomUUID());
    try {
      await this.#startExternalTurn(thread, input.message, turnId);
    } catch (error) {
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
    return this.#turnResult(thread.id, turnId, thread.harnessId);
  }

  async cancel(input: ThreadCancelInput): Promise<ThreadCancelResult> {
    const location = await this.#externalRuntime.locate(input.threadId);
    if (location.kind === "official") return this.#cancelOfficial(input);
    if (location.kind === "error") {
      throw new DelegationControlError("THREAD_NOT_FOUND", location.error.message);
    }
    const resolution = await this.#externalRuntime.resolve(input.threadId);
    if (resolution.kind !== "external") {
      throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    }
    const thread = resolution.thread;
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
    validateReadOptions(input);
    const location = await this.#externalRuntime.locate(input.threadId);
    if (location.kind === "official") return this.#readOfficial(input);
    if (location.kind === "error")
      throw new DelegationControlError("THREAD_NOT_FOUND", location.error.message);
    const resolution = await this.#externalRuntime.resolve(input.threadId);
    if (resolution.kind !== "external") {
      throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    }
    const thread = resolution.thread;
    if (!thread.running && !resolution.historyFresh) {
      const error = await this.#externalRuntime.refresh(thread);
      if (error) throw new DelegationControlError("INTERNAL_ERROR", error.message);
    }
    const turns = thread.activeTurnId
      ? [
          ...thread.turns,
          thread.projectedTurns.get(thread.activeTurnId)?.projector.pendingTurn() ?? {},
        ]
      : thread.turns;
    const snapshot = projectDelegationThreadSnapshot({
      threadId: thread.id,
      harnessId: thread.harnessId,
      thread: thread.thread,
      turns,
      running: thread.running,
      view: input.view,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const delegation = await this.#repository.getDelegationByChild(
      hostThreadIdSchema.parse(thread.id),
    );
    if (delegation && delegation.status !== statusFromThread(thread)) {
      await this.#repository.setDelegationStatus(delegation.delegationId, statusFromThread(thread));
    }
    return snapshot;
  }

  async wait(input: ThreadWaitInput): Promise<DelegationThreadSnapshot & { timedOut: boolean }> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new DelegationControlError("INVALID_ARGUMENT", "timeoutMs must be a positive integer");
    }
    const deadline = Date.now() + input.timeoutMs;
    while (true) {
      const snapshot = await this.read(input);
      if (terminal(snapshot.status)) return { ...snapshot, timedOut: false };
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

  async #resolveParent(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    const environmentThreadId = this.#environment[DELEGATION_THREAD_ID_ENV];
    if (environmentThreadId) return environmentThreadId;
    const external = this.#externalRuntime
      .values()
      .filter((thread) => thread.running)
      .map((thread) => thread.id);
    const official = this.#activeOfficialParents();
    const active = [...external, ...official];
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

  #validateConfiguration(
    inspection: Awaited<ReturnType<HarnessAdapter["inspect"]>>,
    model: HarnessModelRef | undefined,
    thinkingOptionId: HarnessThinkingOptionId | undefined,
  ): void {
    if (inspection.status !== "ready") {
      throw new DelegationControlError("DELEGATION_FAILED", inspection.error.message, {
        status: inspection.status,
      });
    }
    const selectedModel = model ?? inspection.catalog.defaultModel;
    if (model && !inspection.capabilities.configuration.selectModel) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Harness does not support Model selection",
      );
    }
    if (model && !inspection.catalog.models.some((candidate) => candidate.ref.id === model.id)) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Model is unavailable for the target Harness",
        {
          validModelIds: inspection.catalog.models.map((candidate) => candidate.ref.id),
        },
      );
    }
    if (!thinkingOptionId) return;
    if (!inspection.capabilities.configuration.selectThinkingOption) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Harness does not support Thinking selection",
      );
    }
    const modelEntry = selectedModel
      ? inspection.catalog.models.find((candidate) => candidate.ref.id === selectedModel.id)
      : undefined;
    const validThinkingOptionIds = modelEntry?.supportedThinkingOptionIds ?? [];
    if (!validThinkingOptionIds.includes(thinkingOptionId)) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Thinking option is unavailable for the selected Model",
        { validThinkingOptionIds },
      );
    }
  }

  async #parentMetadata(parentThreadId: string): Promise<{ harnessId: RoutedHarnessId }> {
    const record = await this.#repository.find(parentThreadId);
    return { harnessId: record ? (record.harnessId as RoutedHarnessId) : "codex" };
  }

  async #existingResult(delegation: StoredDelegationRecordV1): Promise<DelegationStartResult> {
    const record = await this.#repository.find(delegation.childHostThreadId);
    const turnId = record?.turnMappings.at(-1)?.hostTurnId ?? "pending";
    return this.#result(
      delegation.delegationId,
      delegation.childHostThreadId,
      turnId,
      delegation.targetHarnessId as RoutedHarnessId,
      delegation.status,
      { requested: { executionPolicy: delegation.executionPolicy ?? "approval-required" } },
    );
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
