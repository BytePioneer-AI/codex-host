import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type {
  HarnessAdapter,
  HarnessModelRef,
  HarnessSession,
  HarnessSessionState,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";
import {
  MappingStoreError,
  type StoredDelegationRecordV1,
  type StoredThreadRecordV1,
} from "@codexhost/mapping-store";
import {
  encodeExternalTransportSelection,
  transportModelIdForHarness,
  type ExternalHarnessId,
  type JsonObject,
  type RoutedHarnessId,
} from "@codexhost/protocol-core";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  DELEGATION_THREAD_ID_ENV,
  DelegationControlError,
  delegationNextCommands,
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
  type ThreadStatusInput,
  type DelegationThreadStatusView,
  type ThreadWaitManyInput,
  type ThreadWaitManyResult,
  type ThreadEvidenceInput,
  type ThreadEvidenceResult,
  type ThreadConfigurationInput,
  type ThreadReleaseInput,
  type ThreadReleaseResult,
  type DelegationReconcileInput,
  type DelegationReconcileResult,
  type DelegationUnknownConfigField,
  type JobQuiescence,
} from "./delegation-types.js";
import {
  projectDelegationEvidence,
  projectDelegationThreadSnapshot,
  validateReadOptions,
} from "./delegation-snapshot.js";
import { decodeThreadRevision } from "./thread-change-hub.js";
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
  input: Pick<DelegationStartInput, "task" | "cwd" | "model" | "thinkingOptionId">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        task: input.task,
        cwd: path.resolve(input.cwd),
        modelId: input.model?.id ?? null,
        thinkingOptionId: input.thinkingOptionId ?? null,
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
  readonly #inflight = new Map<
    string,
    { input: DelegationStartInput; promise: Promise<DelegationStartResult> }
  >();
  readonly #inflightSends = new Map<string, Promise<ThreadSendResult>>();

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
    validateStart(input);
    if (input.requestId) {
      const current = this.#inflight.get(input.requestId);
      if (current) {
        this.#assertSameStartIdentity(current.input, input);
        return current.promise;
      }
    }
    const pending: {
      input: DelegationStartInput;
      promise: Promise<DelegationStartResult>;
    } = { input, promise: Promise.resolve() as unknown as Promise<DelegationStartResult> };
    pending.promise = this.#deliverStart(input).finally(() => {
      if (input.requestId && this.#inflight.get(input.requestId) === pending) {
        this.#inflight.delete(input.requestId);
      }
    });
    if (input.requestId) this.#inflight.set(input.requestId, pending);
    return pending.promise;
  }

  async #deliverStart(input: DelegationStartInput): Promise<DelegationStartResult> {
    const parentThreadId = await this.#resolveParent(input.parentThreadId);
    if (input.harnessId === "codex") return this.#startOfficial({ ...input, parentThreadId });
    if (!this.#adapters.has(input.harnessId)) {
      throw new DelegationControlError(
        "HARNESS_NOT_FOUND",
        `Harness '${input.harnessId}' is unavailable`,
        { validHarnessIds: ["codex", ...this.#adapters.keys()] },
      );
    }
    const targetHarnessId = input.harnessId as ExternalHarnessId;
    const digest = taskDigest(input);
    const duplicate = input.requestId
      ? await this.#repository.findDelegationByRequest(input.requestId)
      : await this.#repository.findRecentDelegation({
          parentHostThreadId: hostThreadIdSchema.parse(parentThreadId),
          targetHarnessId: harnessIdSchema.parse(targetHarnessId),
          taskDigest: digest,
          since: new Date(Date.now() - IMPLICIT_DEDUPLICATION_MS),
        });
    if (duplicate && input.requestId) {
      this.#assertStoredIdentity(duplicate, {
        parentThreadId,
        targetHarnessId,
        digest,
      });
    }
    if (duplicate) return this.#existingResult(duplicate);

    const adapter = this.#adapters.get(targetHarnessId);
    if (!adapter) {
      throw new DelegationControlError(
        "HARNESS_NOT_FOUND",
        `Harness '${targetHarnessId}' is unavailable`,
        { validHarnessIds: ["codex", ...this.#adapters.keys()] },
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
    const cwd = path.resolve(input.cwd);
    let createdHere = false;
    let nativeCommitted = false;
    let record: StoredThreadRecordV1 | undefined;
    let delegation: StoredDelegationRecordV1 | undefined;
    let session: HarnessSession | null = null;
    try {
      const created = await this.#repository.createDelegatedThread({
        thread: createExternalThreadRecordInput({
          hostThreadId: childThreadId,
          createRequestId,
          harnessId: harnessIdSchema.parse(targetHarnessId),
          cwd,
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
        delegation: {
          delegationId,
          parentHostThreadId: hostThreadIdSchema.parse(parentThreadId),
          childHostThreadId: childThreadId,
          sourceHarnessId: harnessIdSchema.parse(parent.harnessId),
          targetHarnessId: harnessIdSchema.parse(targetHarnessId),
          status: "creating",
          ...(input.requestId ? { requestId: input.requestId } : {}),
          taskDigest: digest,
          latestHostTurnId: turnId,
        },
      });
      record = created.thread;
      delegation = created.delegation;
      createdHere = !created.reused;
      if (created.reused) return this.#existingResult(delegation);
      record = await this.#repository.addPendingHostTurn(record.hostThreadId, turnId);
      const opened = await adapter.open({
        kind: "create",
        cwd: record.cwd,
        environment: { ...this.#environment, [DELEGATION_THREAD_ID_ENV]: record.hostThreadId },
        executionPolicy: "unattended-full-access",
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
        nativeCommitted = true;
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
      await this.#repository.setDelegationLatestTurn(delegation.delegationId, turnId);
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
        nativeCommitted = true;
      }
      await this.#repository.setDelegationStatus(delegation.delegationId, "running");
      await this.#notifyThreadStarted(thread.thread);
      thread.changes.bump();
      return this.#result(
        delegation.delegationId,
        record.hostThreadId,
        turnId,
        targetHarnessId,
        "running",
        {
          requested: {
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
              ? {
                  effectiveThinkingOptionId: thread.stateObserver.state.effectiveThinkingOptionId,
                }
              : {}),
          },
        },
      );
    } catch (error) {
      if (error instanceof MappingStoreError && error.code === "MAPPING_CONFLICT") {
        throw new DelegationControlError("INVALID_ARGUMENT", error.message);
      }
      const keep =
        nativeCommitted ||
        (session?.initialState.nativeRef !== undefined && session.initialState.nativeRef !== null);
      if (!keep) {
        if (session) await session.close().catch(() => undefined);
        this.#externalRuntime.remove(childThreadId);
        if (createdHere && delegation) {
          await this.#repository.removeDelegation(delegation.delegationId).catch(() => undefined);
          await this.#repository
            .removeThread(record?.hostThreadId ?? childThreadId)
            .catch(() => undefined);
        }
      }
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
    if (input.requestId) {
      const current = this.#inflightSends.get(`${input.threadId}:${input.requestId}`);
      if (current) return current;
    }
    const pending = this.#deliverSend(input).finally(() => {
      if (input.requestId) this.#inflightSends.delete(`${input.threadId}:${input.requestId}`);
    });
    if (input.requestId) this.#inflightSends.set(`${input.threadId}:${input.requestId}`, pending);
    return pending;
  }

  async #deliverSend(input: ThreadSendInput): Promise<ThreadSendResult> {
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
    if (
      input.expectedTurnId &&
      thread.activeTurnId &&
      thread.activeTurnId !== input.expectedTurnId
    ) {
      throw new DelegationControlError(
        "STALE_TURN",
        "expected-turn does not match the active Turn",
        { expectedTurnId: input.expectedTurnId, activeTurnId: thread.activeTurnId },
      );
    }
    if (input.expectedTurnId && !thread.running && !thread.activeTurnId) {
      const last = thread.turns.at(-1);
      const lastId = typeof last?.id === "string" ? last.id : undefined;
      if (lastId && lastId !== input.expectedTurnId) {
        throw new DelegationControlError(
          "STALE_TURN",
          "expected-turn does not match the latest Turn",
          { expectedTurnId: input.expectedTurnId, latestTurnId: lastId },
        );
      }
    }
    if (thread.running || thread.activeTurnId) {
      throw new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");
    }
    const turnId = hostTurnIdSchema.parse(randomUUID());
    try {
      thread.record = await this.#repository.addPendingHostTurn(thread.record.hostThreadId, turnId);
      await this.#startExternalTurn(thread, input.message, turnId);
      const delegation = await this.#repository.getDelegationByChild(thread.record.hostThreadId);
      if (delegation) {
        await this.#repository.setDelegationLatestTurn(delegation.delegationId, turnId);
        await this.#repository.setDelegationStatus(delegation.delegationId, "running");
      }
      thread.changes.bump();
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
    const latestTurnId =
      turnId ??
      (typeof thread.turns.at(-1)?.id === "string" ? (thread.turns.at(-1)?.id as string) : undefined);
    if (input.expectedTurnId && latestTurnId && latestTurnId !== input.expectedTurnId) {
      throw new DelegationControlError(
        "STALE_TURN",
        "expected-turn does not match the active Turn",
        { expectedTurnId: input.expectedTurnId, activeTurnId: latestTurnId },
      );
    }
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
      const resolution = await this.#externalRuntime.resolve(input.threadId).catch(() => null);
      if (resolution && resolution.kind === "external") {
        await resolution.thread.changes.wait(resolution.thread.changes.revision, remaining);
      } else {
        await delay(Math.min(100, remaining));
      }
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
    const environmentThreadId =
      this.#environment[DELEGATION_THREAD_ID_ENV] ?? this.#environment.CODEX_THREAD_ID;
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
    const turnId =
      delegation.latestHostTurnId ??
      record?.pendingHostTurnIds?.at(-1) ??
      record?.turnMappings.at(-1)?.hostTurnId;
    if (!turnId) {
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        "Delegation exists but has no confirmed Turn identity",
        { threadId: delegation.childHostThreadId, status: delegation.status },
      );
    }
    return this.#result(
      delegation.delegationId,
      delegation.childHostThreadId,
      turnId,
      delegation.targetHarnessId as RoutedHarnessId,
      delegation.status,
    );
  }

  #assertSameStartIdentity(left: DelegationStartInput, right: DelegationStartInput): void {
    if (
      left.parentThreadId !== right.parentThreadId ||
      left.harnessId !== right.harnessId ||
      taskDigest(left) !== taskDigest(right)
    ) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Request ID is already associated with another Delegation configuration",
      );
    }
  }

  #assertStoredIdentity(
    stored: StoredDelegationRecordV1,
    expected: { parentThreadId: string; targetHarnessId: ExternalHarnessId; digest: string },
  ): void {
    if (
      stored.parentHostThreadId !== expected.parentThreadId ||
      stored.targetHarnessId !== expected.targetHarnessId ||
      stored.taskDigest !== expected.digest
    ) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Request ID is already associated with another Delegation configuration",
      );
    }
  }

  #next(threadId: string): { read: string; wait: string } {
    return delegationNextCommands(this.#environment, threadId);
  }

  #turnResult(threadId: string, turnId: string, harnessId: RoutedHarnessId): ThreadSendResult {
    return {
      threadId,
      turnId,
      harnessId,
      status: "running",
      next: this.#next(threadId),
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
      next: this.#next(threadId),
    };
  }

  async status(input: ThreadStatusInput): Promise<DelegationThreadStatusView> {
    return this.#statusView(input.threadId);
  }

  async configuration(
    input: ThreadConfigurationInput,
  ): Promise<DelegationThreadStatusView["configuration"]> {
    return (await this.#statusView(input.threadId)).configuration;
  }

  async waitMany(input: ThreadWaitManyInput): Promise<ThreadWaitManyResult> {
    if (!Array.isArray(input.targets) || input.targets.length === 0) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "wait-many requires at least one target",
      );
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 60_000) {
      throw new DelegationControlError("INVALID_ARGUMENT", "timeoutMs must be between 0 and 60000");
    }
    const deadline = Date.now() + input.timeoutMs;
    const collect = async (): Promise<ThreadWaitManyResult> => {
      const results = await Promise.all(
        input.targets.map(async (target) => this.#waitManyTarget(target)),
      );
      const changed = results.some(
        (result) => result.outcome === "changed" || result.outcome === "resync",
      );
      return { timedOut: !changed, results };
    };
    let snapshot = await collect();
    if (!snapshot.timedOut || input.timeoutMs === 0)
      return { ...snapshot, timedOut: snapshot.timedOut };
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await Promise.race([
        delay(remaining),
        ...input.targets.map(async (target) => {
          const resolution = await this.#externalRuntime.resolve(target.threadId).catch(() => null);
          if (resolution && resolution.kind === "external") {
            await resolution.thread.changes.wait(resolution.thread.changes.revision, remaining);
          }
        }),
      ]);
      snapshot = await collect();
      if (!snapshot.timedOut) return snapshot;
    }
    return snapshot;
  }

  async evidence(input: ThreadEvidenceInput): Promise<ThreadEvidenceResult> {
    await this.read({ threadId: input.threadId, view: "result" });
    const resolution = await this.#externalRuntime.resolve(input.threadId);
    const turns =
      resolution.kind === "external"
        ? resolution.thread.activeTurnId
          ? [
              ...resolution.thread.turns,
              resolution.thread.projectedTurns
                .get(resolution.thread.activeTurnId)
                ?.projector.pendingTurn() ?? {},
            ]
          : resolution.thread.turns
        : [];
    return projectDelegationEvidence({
      threadId: input.threadId,
      turns,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      includeOutput: input.includeOutput === true,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }

  async release(input: ThreadReleaseInput): Promise<ThreadReleaseResult> {
    const resolution = await this.#externalRuntime.resolve(input.threadId);
    if (resolution.kind !== "external") {
      throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    }
    const thread = resolution.thread;
    if (
      input.expectedTurnId &&
      thread.activeTurnId &&
      thread.activeTurnId !== input.expectedTurnId
    ) {
      throw new DelegationControlError(
        "STALE_TURN",
        "expected-turn does not match the active Turn",
        { expectedTurnId: input.expectedTurnId, activeTurnId: thread.activeTurnId },
      );
    }
    if (thread.running || thread.activeTurnId) {
      return {
        threadId: thread.id,
        released: false,
        busy: true,
        quiescence: "unknown",
      };
    }
    const adapter = this.#adapters.get(thread.harnessId);
    const releasable = adapter && isOwnedJobAdapter(adapter) ? adapter : undefined;
    let quiescence: JobQuiescence = releasable ? "unknown" : "unsupported";
    let proof: ThreadReleaseResult["proof"];
    if (releasable) {
      const stopped = await releasable.stopOwnedJobs(thread.session);
      quiescence = stopped.quiescence;
      proof = stopped.proof;
    }
    if (quiescence !== "confirmed" && releasable) {
      return {
        threadId: thread.id,
        released: false,
        busy: false,
        quiescence,
        ...(proof ? { proof } : {}),
      };
    }
    await thread.session.close().catch(() => undefined);
    this.#externalRuntime.remove(thread.id);
    return {
      threadId: thread.id,
      released: true,
      busy: false,
      quiescence: releasable ? quiescence : "unsupported",
      ...(proof ? { proof } : {}),
    };
  }

  async reconcile(input: DelegationReconcileInput): Promise<DelegationReconcileResult> {
    const parsed = hostThreadIdSchema.safeParse(input.threadId);
    if (!parsed.success) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is invalid");
    }
    const thread = await this.#repository.find(parsed.data);
    const delegation = await this.#repository.getDelegationByChild(parsed.data);
    if (!thread && !delegation) {
      throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    }
    const loaded = this.#externalRuntime.get(input.threadId);
    const nativeUnknown = Boolean(
      thread && (thread.state !== "ready" || !thread.nativeSessionRef) && !loaded,
    );
    const active = Boolean(loaded?.running);
    if (active || nativeUnknown) {
      return {
        threadId: input.threadId,
        dryRun: input.apply !== true,
        applied: false,
        action: "rejected",
        writes: 0,
        reason: active
          ? "Thread still has active work"
          : "Native side effects are unknown; apply is refused",
      };
    }
    if (input.apply !== true) {
      return {
        threadId: input.threadId,
        dryRun: true,
        applied: false,
        action: thread?.state === "ready" ? "reload" : "mark-unconfirmed",
        writes: 0,
      };
    }
    if (thread?.state === "ready" && thread.nativeSessionRef) {
      await this.#externalRuntime.resolve(input.threadId);
      return {
        threadId: input.threadId,
        dryRun: false,
        applied: true,
        action: "reload",
        writes: 0,
      };
    }
    return {
      threadId: input.threadId,
      dryRun: false,
      applied: false,
      action: "rejected",
      writes: 0,
      reason: "Record cannot be applied without confirmed native inactivity",
    };
  }

  async #statusView(threadId: string): Promise<DelegationThreadStatusView> {
    const snapshot = await this.read({ threadId, view: "result" });
    const resolution = await this.#externalRuntime.resolve(threadId).catch(() => null);
    const thread = resolution && resolution.kind === "external" ? resolution.thread : undefined;
    const delegation = await this.#repository.getDelegationByChild(
      hostThreadIdSchema.parse(threadId),
    );
    const record = await this.#repository.find(threadId);
    const unknown: DelegationUnknownConfigField[] = [];
    const requested = thread
      ? {
          ...(thread.requestedModel ? { model: thread.requestedModel } : {}),
          ...(thread.requestedThinkingOptionId
            ? { thinkingOptionId: thread.requestedThinkingOptionId }
            : {}),
          ...(thread.requestedPermissionModeId
            ? { permissionModeId: thread.requestedPermissionModeId }
            : {}),
        }
      : undefined;
    const effective = thread
      ? {
          ...(thread.stateObserver.state.effectiveModel
            ? { effectiveModel: thread.stateObserver.state.effectiveModel }
            : {}),
          ...(thread.stateObserver.state.resolvedModelLabel
            ? { resolvedModelLabel: thread.stateObserver.state.resolvedModelLabel }
            : {}),
          ...(thread.stateObserver.state.effectiveThinkingOptionId
            ? { effectiveThinkingOptionId: thread.stateObserver.state.effectiveThinkingOptionId }
            : {}),
          ...(thread.stateObserver.state.effectivePermissionModeId
            ? { effectivePermissionModeId: thread.stateObserver.state.effectivePermissionModeId }
            : {}),
        }
      : undefined;
    if (!snapshot.harnessId) unknown.push("harness");
    if (!effective?.effectiveModel) unknown.push("model");
    if (!effective?.effectiveThinkingOptionId) unknown.push("thinking");
    if (!effective?.effectivePermissionModeId) unknown.push("permissionMode");
    if (!record?.cwd && !thread?.cwd) unknown.push("cwd");
    if (!delegation?.parentHostThreadId) unknown.push("parent");
    if (!snapshot.turn) unknown.push("turn");
    if (!delegation) unknown.push("delegation");
    const revision = thread
      ? thread.changes.encode({
          threadId,
          turnId: snapshot.turn?.turnId ?? null,
          status: snapshot.status,
        })
      : `codexhost:thread-revision:v1:${Buffer.from(
          JSON.stringify({
            version: 1,
            epoch: this.#externalRuntime.epoch,
            seq: 0,
            threadId,
            turnId: snapshot.turn?.turnId ?? null,
            status: snapshot.status,
          }),
        ).toString("base64url")}`;
    const cwd = record?.cwd ?? thread?.cwd;
    return {
      threadId,
      harnessId: snapshot.harnessId,
      status: snapshot.status,
      turn: snapshot.turn,
      revision,
      ...(cwd ? { cwd } : {}),
      ...(delegation
        ? { parentThreadId: delegation.parentHostThreadId, delegationId: delegation.delegationId }
        : {}),
      configuration: {
        ...(requested && Object.keys(requested).length > 0 ? { requested } : {}),
        ...(effective && Object.keys(effective).length > 0 ? { effective } : {}),
        unknown,
      },
    };
  }

  async #waitManyTarget(
    target: ThreadWaitManyInput["targets"][number],
  ): Promise<ThreadWaitManyResult["results"][number]> {
    try {
      const status = await this.#statusView(target.threadId);
      const decoded = decodeThreadRevision(target.threadId, target.afterRevision);
      if (decoded && "invalid" in decoded) {
        return {
          threadId: target.threadId,
          outcome: "resync",
          revision: status.revision,
          status,
        };
      }
      if (decoded && decoded.epoch !== this.#externalRuntime.epoch) {
        return {
          threadId: target.threadId,
          outcome: "resync",
          revision: status.revision,
          status,
        };
      }
      if (!target.afterRevision || status.revision !== target.afterRevision) {
        return {
          threadId: target.threadId,
          outcome: "changed",
          revision: status.revision,
          status,
        };
      }
      return {
        threadId: target.threadId,
        outcome: "timedOut",
        revision: status.revision,
        status,
      };
    } catch (error) {
      const normalized =
        error instanceof DelegationControlError
          ? error
          : new DelegationControlError(
              "INTERNAL_ERROR",
              error instanceof Error ? error.message : String(error),
            );
      return {
        threadId: target.threadId,
        outcome: "error",
        error: { code: normalized.code, message: normalized.message },
      };
    }
  }
}

function isOwnedJobAdapter(adapter: HarnessAdapter): adapter is HarnessAdapter & {
  stopOwnedJobs(session: HarnessSession): Promise<{
    quiescence: JobQuiescence;
    proof?: ThreadReleaseResult["proof"];
  }>;
} {
  return typeof (adapter as { stopOwnedJobs?: unknown }).stopOwnedJobs === "function";
}
