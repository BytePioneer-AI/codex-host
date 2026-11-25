import type { HarnessAdapter, HarnessSession } from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  mapExternalThreadHarnessError,
  transportModelIdForHarness,
  type ExternalHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
  type TodoPlan,
} from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  harnessModelRefFromKey,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  threadHandoffMetadataSchema,
  threadHandoffResultSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type ThreadHandoffParams,
  type ThreadHandoffResult,
} from "@codexhost/shared-contracts";

import { threadDelegationEnvironment } from "./bearer-token.js";
import { errorMessage } from "./desktop-rpc.js";
import {
  createExternalThreadRecordInput,
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import type {
  ExternalThread,
  ExternalThreadLocation,
  ExternalThreadResolution,
  ExternalThreadRuntime,
} from "./external-thread-runtime.js";
import { officialCodexModelSelection } from "./official-codex-model-ref.js";
import { buildThreadHandoffPackage } from "./thread-handoff.js";

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonBlankRawString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseTodoPlan(value: unknown): TodoPlan | null {
  if (!isRecord(value) || !Array.isArray(value.plan)) return null;
  const plan: TodoPlan["plan"] = [];
  for (const entry of value.plan) {
    if (!isRecord(entry) || typeof entry.step !== "string") continue;
    const status =
      entry.status === "completed" || entry.status === "inProgress" || entry.status === "pending"
        ? entry.status
        : "pending";
    plan.push({ step: entry.step, status });
  }
  const explanation = typeof value.explanation === "string" ? value.explanation : null;
  return plan.length > 0 || explanation ? { explanation, plan } : null;
}

function resolveExternalPlan(
  source: ExternalThread,
  turns: readonly JsonObject[],
  lastTurnId?: string,
): TodoPlan | null {
  let boundaryIndex = -1;
  if (lastTurnId !== undefined) {
    boundaryIndex = turns.findIndex((turn) => turn.id === lastTurnId);
    if (boundaryIndex >= 0 && turns[boundaryIndex]?.status !== "completed") return null;
  } else {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]?.status === "completed") {
        boundaryIndex = index;
        break;
      }
    }
  }
  if (boundaryIndex < 0) return null;
  const eligibleIds = new Set(
    turns
      .slice(0, boundaryIndex + 1)
      .map((turn) => (typeof turn.id === "string" ? turn.id : ""))
      .filter(Boolean),
  );
  if (source.livePlan) {
    const liveTurnId =
      typeof source.livePlan.turnId === "string" ? source.livePlan.turnId : undefined;
    if (liveTurnId !== undefined && eligibleIds.has(liveTurnId)) {
      const parsed = parseTodoPlan(source.livePlan);
      if (parsed) return parsed;
    }
  }
  for (let index = boundaryIndex; index >= 0; index -= 1) {
    const turnId = turns[index]?.id;
    if (typeof turnId !== "string") continue;
    const plan = source.historicalPlans.get(turnId);
    if (plan) return plan;
  }
  return null;
}

function externalSourceModel(source: ExternalThread): string | undefined {
  let persistedModel: string | undefined;
  try {
    persistedModel = decodeExternalTransportSelection(source.harnessId, source.transportModelId)
      ?.model?.id;
  } catch {
    persistedModel = undefined;
  }
  return (
    source.stateObserver.state.resolvedModelLabel ??
    source.stateObserver.state.effectiveModel?.id ??
    source.requestedModel?.id ??
    persistedModel
  );
}

export type ThreadHandoffExecutionResult =
  | { ok: false; error: ExternalThreadRpcError }
  | {
      ok: true;
      result: ThreadHandoffResult;
      externalStartedThread?: JsonObject;
      officialStartedThread?: JsonObject;
    };

export interface ExecuteThreadHandoffInput {
  params: ThreadHandoffParams;
  adapters: ReadonlyMap<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  environment: NodeJS.ProcessEnv;
  harnessLabel(harnessId: HarnessId): string;
  locateExternalThread(threadId: string): Promise<ExternalThreadLocation>;
  resolveExternalThread(threadId: string): Promise<ExternalThreadResolution>;
  refreshExternalThread(thread: ExternalThread): Promise<ExternalThreadRpcError | null>;
  externalHistoryTurns(thread: ExternalThread): JsonObject[];
  registerExternalThread(input: Parameters<ExternalThreadRuntime["register"]>[0]): ExternalThread;
  requestOfficial(method: string, params: JsonObject): Promise<JsonObject>;
  diagnose?(error: unknown): void;
}

export async function executeThreadHandoff(
  input: ExecuteThreadHandoffInput,
): Promise<ThreadHandoffExecutionResult> {
  const { params, adapters, repository, runtime, environment } = input;

  let targetModelRef: HarnessModelRef | undefined;
  if (params.targetModel !== undefined) {
    try {
      targetModelRef = harnessModelRefFromKey(params.targetModel);
    } catch {
      return { ok: false, error: { code: -32602, message: "Invalid target Model Ref" } };
    }
  }
  let targetThinkingOptionId: HarnessThinkingOptionId | undefined;
  if (params.targetThinkingOptionId !== undefined) {
    const parsedThinking = harnessThinkingOptionIdSchema.safeParse(params.targetThinkingOptionId);
    if (!parsedThinking.success) {
      return { ok: false, error: { code: -32602, message: "Invalid target Thinking option ID" } };
    }
    targetThinkingOptionId = parsedThinking.data;
  }

  const targetHarnessId = params.targetHarnessId;
  const targetAdapter =
    targetHarnessId === "codex" ? undefined : adapters.get(targetHarnessId as ExternalHarnessId);
  if (targetHarnessId !== "codex" && !targetAdapter) {
    return {
      ok: false,
      error: { code: -32070, message: `External Harness '${targetHarnessId}' is unavailable` },
    };
  }

  // Read source history and metadata from official Codex or external Harness.
  const location = await input.locateExternalThread(params.sourceThreadId);
  if (location.kind === "error") return { ok: false, error: location.error };

  let sourceHarnessId: HarnessId;
  let sourceHarnessLabel: string;
  let sourceModel: string | undefined;
  let cwd: string;
  let title: string | undefined;
  let turns: JsonObject[];
  let latestPlan: TodoPlan | null = null;

  if (location.kind === "official") {
    let response: JsonObject;
    try {
      response = await input.requestOfficial("thread/read", {
        threadId: params.sourceThreadId,
        includeTurns: true,
      });
    } catch (error) {
      return {
        ok: false,
        error: { code: -32076, message: `Source Thread could not be read: ${errorMessage(error)}` },
      };
    }
    if (isRecord(response.error)) {
      return {
        ok: false,
        error: {
          code: typeof response.error.code === "number" ? response.error.code : -32076,
          message:
            typeof response.error.message === "string"
              ? response.error.message
              : "Source Thread could not be read",
        },
      };
    }
    const result = isRecord(response.result) ? response.result : null;
    const thread = result && isRecord(result.thread) ? result.thread : null;
    if (!thread) {
      return { ok: false, error: { code: -32080, message: "Source Thread was not found" } };
    }
    const sourceCwd = nonBlankRawString(thread.cwd);
    if (!sourceCwd) {
      return {
        ok: false,
        error: { code: -32080, message: "Source Thread working directory is unavailable" },
      };
    }
    cwd = sourceCwd;
    title = nonEmptyString(thread.name) ?? nonEmptyString(thread.preview);
    sourceHarnessId = harnessIdSchema.parse("codex");
    sourceHarnessLabel = input.harnessLabel(sourceHarnessId);
    sourceModel = nonEmptyString(thread.model);
    turns = Array.isArray(thread.turns)
      ? thread.turns.filter((turn): turn is JsonObject => isRecord(turn))
      : [];
  } else {
    const resolution = await input.resolveExternalThread(params.sourceThreadId);
    if (resolution.kind === "error") return { ok: false, error: resolution.error };
    if (resolution.kind !== "external") {
      return { ok: false, error: { code: -32078, message: "Source Thread is unavailable" } };
    }
    const source = resolution.thread;
    if (!source.running) {
      const refreshError = await input.refreshExternalThread(source);
      if (refreshError) return { ok: false, error: refreshError };
    }
    cwd = source.cwd;
    title = nonEmptyString(source.record.title) ?? nonEmptyString(source.thread.name);
    sourceHarnessId = harnessIdSchema.parse(source.harnessId);
    sourceHarnessLabel = input.harnessLabel(sourceHarnessId);
    sourceModel = externalSourceModel(source);
    turns = input.externalHistoryTurns(source);
    latestPlan = resolveExternalPlan(source, turns, params.lastTurnId);
  }

  const targetHarnessLabel = input.harnessLabel(targetHarnessId);
  const built = buildThreadHandoffPackage({
    sourceThreadId: params.sourceThreadId,
    sourceHarnessId,
    sourceHarnessLabel,
    ...(sourceModel ? { sourceModel } : {}),
    targetHarnessId,
    targetHarnessLabel,
    ...(targetModelRef ? { targetModel: targetModelRef.id } : {}),
    cwd,
    ...(title ? { title } : {}),
    turns,
    ...(params.lastTurnId ? { lastTurnId: params.lastTurnId } : {}),
    latestPlan,
  });
  if (!built.ok) {
    return { ok: false, error: { code: built.code, message: built.message } };
  }

  if (targetHarnessId === "codex") {
    return createOfficialHandoffTarget({
      cwd,
      ...(title ? { title } : {}),
      ...(targetModelRef ? { targetModelRef } : {}),
      ...(targetThinkingOptionId ? { targetThinkingOptionId } : {}),
      contextText: built.value.contextText,
      metadata: built.value.metadata,
      sourceThreadId: params.sourceThreadId,
      repository,
      requestOfficial: input.requestOfficial,
      ...(input.diagnose ? { diagnose: input.diagnose } : {}),
    });
  }

  if (!targetAdapter) {
    return {
      ok: false,
      error: { code: -32070, message: `External Harness '${targetHarnessId}' is unavailable` },
    };
  }

  return createExternalHandoffTarget({
    adapter: targetAdapter,
    targetHarnessId: targetHarnessId as ExternalHarnessId,
    cwd,
    ...(title ? { title } : {}),
    ...(targetModelRef ? { targetModelRef } : {}),
    ...(targetThinkingOptionId ? { targetThinkingOptionId } : {}),
    contextText: built.value.contextText,
    metadata: built.value.metadata,
    repository,
    runtime,
    environment,
    registerExternalThread: input.registerExternalThread,
  });
}

async function createOfficialHandoffTarget(input: {
  cwd: string;
  title?: string;
  targetModelRef?: HarnessModelRef;
  targetThinkingOptionId?: HarnessThinkingOptionId;
  contextText: string;
  metadata: ThreadHandoffResult["handoff"];
  sourceThreadId: string;
  repository: ExternalThreadRepository;
  requestOfficial(method: string, params: JsonObject): Promise<JsonObject>;
  diagnose?(error: unknown): void;
}): Promise<ThreadHandoffExecutionResult> {
  const nativeSelection = input.targetModelRef
    ? officialCodexModelSelection(input.targetModelRef)
    : undefined;
  let started: JsonObject;
  try {
    started = await input.requestOfficial("thread/start", {
      cwd: input.cwd,
      ...nativeSelection,
      ...(input.targetThinkingOptionId
        ? { config: { model_reasoning_effort: input.targetThinkingOptionId } }
        : {}),
      ephemeral: false,
      historyMode: "paginated",
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: -32076,
        message: `Codex target Thread could not be started: ${errorMessage(error)}`,
      },
    };
  }
  if (isRecord(started.error)) {
    return {
      ok: false,
      error: {
        code: typeof started.error.code === "number" ? started.error.code : -32076,
        message:
          typeof started.error.message === "string"
            ? started.error.message
            : "Codex target Thread could not be started",
      },
    };
  }
  const startedResult = isRecord(started.result) ? started.result : null;
  const thread = startedResult && isRecord(startedResult.thread) ? startedResult.thread : null;
  const newThreadId = thread ? nonEmptyString(thread.id) : undefined;
  if (!thread || !newThreadId || newThreadId === input.sourceThreadId) {
    return {
      ok: false,
      error: { code: -32081, message: "Codex did not return a distinct handoff Thread ID" },
    };
  }

  try {
    const injected = await input.requestOfficial("thread/inject_items", {
      threadId: newThreadId,
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input.contextText }],
        },
      ],
    });
    if (isRecord(injected.error)) {
      throw new Error(
        typeof injected.error.message === "string"
          ? injected.error.message
          : "thread/inject_items failed",
      );
    }
    const confirmedModel = nonEmptyString(startedResult?.model) ?? input.metadata.targetModel;
    const metadata = threadHandoffMetadataSchema.parse({
      ...input.metadata,
      ...(confirmedModel ? { targetModel: confirmedModel } : {}),
    });
    const parsedTargetId = hostThreadIdSchema.parse(newThreadId);
    await input.repository.saveThreadHandoff(parsedTargetId, metadata);
    if (input.title) {
      await input
        .requestOfficial("thread/name/set", { threadId: newThreadId, name: input.title })
        .catch(() => undefined);
    }
    const officialStartedThread: JsonObject = {
      ...thread,
      ...(input.title ? { name: input.title } : {}),
    };
    return {
      ok: true,
      result: threadHandoffResultSchema.parse({ threadId: parsedTargetId, handoff: metadata }),
      officialStartedThread,
    };
  } catch (error) {
    await input.repository.removeThreadHandoff(newThreadId).catch((cleanupError) => {
      input.diagnose?.(cleanupError);
    });
    try {
      const deleted = await input.requestOfficial("thread/delete", { threadId: newThreadId });
      if (isRecord(deleted.error)) {
        const message =
          typeof deleted.error.message === "string"
            ? deleted.error.message
            : "thread/delete failed";
        input.diagnose?.(
          new Error(`Failed to roll back official handoff Thread ${newThreadId}: ${message}`),
        );
      }
    } catch (cleanupError) {
      input.diagnose?.(cleanupError);
    }
    return {
      ok: false,
      error: {
        code: -32081,
        message: `Codex handoff context injection failed: ${errorMessage(error)}`,
      },
    };
  }
}

async function createExternalHandoffTarget(input: {
  adapter: HarnessAdapter;
  targetHarnessId: ExternalHarnessId;
  cwd: string;
  title?: string;
  targetModelRef?: HarnessModelRef;
  targetThinkingOptionId?: HarnessThinkingOptionId;
  contextText: string;
  metadata: ThreadHandoffResult["handoff"];
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  environment: NodeJS.ProcessEnv;
  registerExternalThread(input: Parameters<ExternalThreadRuntime["register"]>[0]): ExternalThread;
}): Promise<ThreadHandoffExecutionResult> {
  const { adapter, targetHarnessId, cwd, repository, runtime, environment } = input;
  const transportModelId =
    input.targetModelRef || input.targetThinkingOptionId
      ? encodeExternalTransportSelection(targetHarnessId, {
          ...(input.targetModelRef ? { model: input.targetModelRef } : {}),
          ...(input.targetThinkingOptionId
            ? { thinkingOptionId: input.targetThinkingOptionId }
            : {}),
        })
      : transportModelIdForHarness(targetHarnessId);

  let record: StoredThreadRecordV1;
  try {
    record = await repository.createProvisional(
      createExternalThreadRecordInput({
        harnessId: adapter.harnessId,
        cwd,
        ...(input.title ? { title: input.title } : {}),
        transportModelId,
        ephemeral: false,
        historyMode: "paginated",
      }),
    );
  } catch {
    return {
      ok: false,
      error: { code: -32081, message: "External handoff could not be persisted" },
    };
  }

  let opened: Awaited<ReturnType<HarnessAdapter["open"]>>;
  try {
    opened = await adapter.open({
      kind: "create",
      cwd,
      environment: threadDelegationEnvironment(environment, record.hostThreadId),
      ...(input.targetModelRef ? { model: input.targetModelRef } : {}),
      ...(input.targetThinkingOptionId ? { thinkingOptionId: input.targetThinkingOptionId } : {}),
    });
  } catch {
    await repository.removeProvisional(record.hostThreadId).catch(() => undefined);
    return {
      ok: false,
      error: { code: -32076, message: "External handoff Session failed to open" },
    };
  }
  if (!opened.ok) {
    await repository.removeProvisional(record.hostThreadId).catch(() => undefined);
    return { ok: false, error: mapExternalThreadHarnessError(opened.error, "create") };
  }

  const session: HarnessSession = opened.value;
  return runtime.idleRelease.runOperation(record.hostThreadId, async () => {
    try {
      if (session.initialState.nativeRef) {
        record = await repository.commitNative(record.hostThreadId, session.initialState.nativeRef);
      }
      record = await repository.appendPendingInjectedText(record.hostThreadId, [input.contextText]);
      const confirmedModel =
        session.initialState.resolvedModelLabel ??
        session.initialState.effectiveModel?.id ??
        input.metadata.targetModel;
      const metadata = threadHandoffMetadataSchema.parse({
        ...input.metadata,
        ...(confirmedModel ? { targetModel: confirmedModel } : {}),
      });
      await repository.saveThreadHandoff(record.hostThreadId, metadata);
      const thread = externalThreadValue({
        record,
        turns: [],
        sessionId: record.hostThreadId,
      });
      input.registerExternalThread({
        record,
        session,
        sessionId: record.hostThreadId,
        thread,
        turns: [],
        ...(input.targetModelRef ? { requestedModel: input.targetModelRef } : {}),
        ...(input.targetThinkingOptionId
          ? { requestedThinkingOptionId: input.targetThinkingOptionId }
          : {}),
      });
      return {
        ok: true as const,
        result: threadHandoffResultSchema.parse({
          threadId: record.hostThreadId,
          handoff: metadata,
        }),
        externalStartedThread: thread,
      };
    } catch {
      runtime.remove(record.hostThreadId);
      await session.close().catch(() => undefined);
      await repository.removeThreadHandoff(record.hostThreadId).catch(() => undefined);
      if (record.state === "ready") {
        await repository.removeThread(record.hostThreadId).catch(() => undefined);
      } else {
        await repository.removeProvisional(record.hostThreadId).catch(() => undefined);
      }
      return {
        ok: false as const,
        error: { code: -32081, message: "External handoff could not be persisted" },
      };
    }
  });
}
