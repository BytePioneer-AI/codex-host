import type {
  HarnessAdapter,
  HarnessExecutionPolicy,
  HarnessSession,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import {
  mapExternalThreadHarnessError,
  type DecodedThreadRollbackRequest,
  type ExternalHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  permissionModeFixedAtCreate,
  type HostTurnId,
  type NativeCheckpointRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import { DELEGATION_THREAD_ID_ENV } from "./delegation-types.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";

export type ExternalThreadRollbackResult =
  { ok: false; error: ExternalThreadRpcError } | { ok: true; thread: JsonObject };

function currentConfiguration(current: ExternalThread): HarnessSessionState {
  const state = current.stateObserver.state;
  return {
    ...state,
    ...((state.effectiveModel ?? current.requestedModel)
      ? { effectiveModel: state.effectiveModel ?? current.requestedModel }
      : {}),
    ...((state.effectiveThinkingOptionId ?? current.requestedThinkingOptionId)
      ? {
          effectiveThinkingOptionId:
            state.effectiveThinkingOptionId ?? current.requestedThinkingOptionId,
        }
      : {}),
    ...((state.effectivePermissionModeId ?? current.requestedPermissionModeId)
      ? {
          effectivePermissionModeId:
            state.effectivePermissionModeId ?? current.requestedPermissionModeId,
        }
      : {}),
  };
}

function sameCurrentConfiguration(
  current: HarnessSessionState,
  replacement: HarnessSessionState,
): boolean {
  return (
    current.effectiveModel?.id === replacement.effectiveModel?.id &&
    current.effectiveThinkingOptionId === replacement.effectiveThinkingOptionId &&
    current.effectivePermissionModeId === replacement.effectivePermissionModeId
  );
}

async function restoreCurrentConfiguration(
  session: HarnessSession,
  configuration: HarnessSessionState,
  executionPolicy: HarnessExecutionPolicy,
): Promise<ExternalThreadRpcError | null> {
  if (configuration.effectiveModel) {
    if (!session.capabilities.configuration.selectModel) {
      return { code: -32076, message: "External rollback cannot restore the current Model" };
    }
    const selected = await session.execute({
      type: "model.select",
      model: configuration.effectiveModel,
    });
    if (!selected.ok) return mapExternalThreadHarnessError(selected.error, "fork");
  }
  if (configuration.effectiveThinkingOptionId) {
    if (!session.capabilities.configuration.selectThinkingOption) {
      return { code: -32076, message: "External rollback cannot restore current Thinking" };
    }
    const selected = await session.execute({
      type: "thinking.select",
      thinkingOptionId: configuration.effectiveThinkingOptionId,
    });
    if (!selected.ok) return mapExternalThreadHarnessError(selected.error, "fork");
  }
  if (
    configuration.effectivePermissionModeId &&
    executionPolicy === "default" &&
    !permissionModeFixedAtCreate(session.capabilities.configuration)
  ) {
    if (!session.capabilities.configuration.selectPermissionMode) {
      return {
        code: -32076,
        message: "External rollback cannot restore the current Permission Mode",
      };
    }
    const selected = await session.execute({
      type: "permissionMode.select",
      permissionModeId: configuration.effectivePermissionModeId,
    });
    if (!selected.ok) return mapExternalThreadHarnessError(selected.error, "fork");
  }
  return null;
}

async function executeCurrentLastTurnRollback(input: {
  current: ExternalThread;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  environment?: NodeJS.ProcessEnv;
}): Promise<ExternalThreadRollbackResult> {
  const { current, adapters, repository, runtime } = input;
  if (current.record.turnMappings.length === 0) {
    return {
      ok: false,
      error: { code: -32076, message: "External Thread has no Turn to roll back" },
    };
  }
  const currentNativeRef = current.record.nativeSessionRef;
  const adapter = adapters.get(current.harnessId);
  if (!currentNativeRef || !adapter) {
    return {
      ok: false,
      error: { code: -32079, message: "External Native Session is unavailable" },
    };
  }

  let opened: Awaited<ReturnType<HarnessAdapter["open"]>>;
  let executionPolicy: HarnessExecutionPolicy;
  try {
    executionPolicy = await repository.executionPolicyForThread(current.record);
    opened = await adapter.open({
      kind: "rollbackLastTurn",
      cwd: current.cwd,
      environment: {
        ...(input.environment ?? process.env),
        [DELEGATION_THREAD_ID_ENV]: current.id,
      },
      sourceRef: currentNativeRef as NativeSessionRef,
      executionPolicy,
    });
  } catch {
    return { ok: false, error: { code: -32076, message: "External Thread rollback failed" } };
  }
  if (!opened.ok) {
    return { ok: false, error: mapExternalThreadHarnessError(opened.error, "fork") };
  }

  const session = opened.value;
  const finalNativeRef = session.initialState.nativeRef;
  if (!finalNativeRef || finalNativeRef.harnessId !== current.harnessId) {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      error: { code: -32076, message: "External rollback did not return a valid Session" },
    };
  }
  const configuration = currentConfiguration(current);
  const configurationError = await restoreCurrentConfiguration(
    session,
    configuration,
    executionPolicy,
  );
  if (configurationError) {
    await session.close().catch(() => undefined);
    return { ok: false, error: configurationError };
  }
  const snapshot = await session.readSnapshot();
  if (!snapshot.ok) {
    await session.close().catch(() => undefined);
    return { ok: false, error: mapExternalThreadHarnessError(snapshot.error, "read") };
  }
  if (snapshot.value.turns.length !== current.record.turnMappings.length - 1) {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      error: { code: -32080, message: "External rollback did not remove exactly one Turn" },
    };
  }
  const replacementState = snapshot.value.state ?? session.initialState;
  if (!sameCurrentConfiguration(configuration, replacementState)) {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      error: { code: -32080, message: "External rollback changed configuration" },
    };
  }

  let aligned;
  try {
    aligned = await repository.commitLastTurnRollback(
      current.record,
      finalNativeRef as NativeSessionRef,
      snapshot.value,
    );
  } catch {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      error: { code: -32081, message: "External rollback could not be persisted" },
    };
  }
  const thread = externalThreadValue({
    record: aligned.record,
    turns: aligned.turns,
    sessionId: current.sessionId,
  });
  await runtime.replace(current, {
    record: aligned.record,
    session,
    sessionId: current.sessionId,
    thread,
    turns: aligned.turns,
    restoredState: replacementState,
  });
  return { ok: true, thread };
}

export async function executeExternalThreadRollback(input: {
  derived: ExternalThread;
  rollback: DecodedThreadRollbackRequest;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  expectedLastTurnId?: HostTurnId;
  environment?: NodeJS.ProcessEnv;
}): Promise<ExternalThreadRollbackResult> {
  const { derived, rollback, adapters, repository, runtime, expectedLastTurnId } = input;
  if (derived.running) {
    return { ok: false, error: { code: -32072, message: "External Thread has an active Turn" } };
  }
  const refreshError = await runtime.refresh(derived);
  if (refreshError) return { ok: false, error: refreshError };
  if (
    expectedLastTurnId !== undefined &&
    derived.record.turnMappings.at(-1)?.hostTurnId !== expectedLastTurnId
  ) {
    return {
      ok: false,
      error: { code: -32080, message: "External Revert boundary is unavailable" },
    };
  }
  if (rollback.numTurns === 1 && derived.session.capabilities.history.rollbackLastTurn) {
    return executeCurrentLastTurnRollback({
      current: derived,
      adapters,
      repository,
      runtime,
      ...(input.environment ? { environment: input.environment } : {}),
    });
  }

  const forkSource = derived.record.forkSource;
  if (!forkSource) {
    return {
      ok: false,
      error: {
        code: -32076,
        message: "External rollback requires an untouched Fork-derived Thread",
      },
    };
  }
  const sourceResolution = await runtime.resolve(forkSource.hostThreadId);
  if (sourceResolution.kind === "error") {
    return { ok: false, error: sourceResolution.error };
  }
  if (sourceResolution.kind !== "external") {
    return {
      ok: false,
      error: { code: -32080, message: "External Fork source is unavailable" },
    };
  }
  const source = sourceResolution.thread;
  if (
    source.id === derived.id ||
    source.harnessId !== derived.harnessId ||
    !source.session.capabilities.history.fork ||
    (source.cwd !== derived.cwd && !source.session.capabilities.history.forkAcrossCwd)
  ) {
    return {
      ok: false,
      error: { code: -32076, message: "External rollback source lineage is unsupported" },
    };
  }
  if (!source.running) {
    const sourceRefreshError = await runtime.refresh(source);
    if (sourceRefreshError) return { ok: false, error: sourceRefreshError };
  }

  const sourceBoundaryIndex = source.record.turnMappings.findIndex(
    ({ hostTurnId }) => hostTurnId === forkSource.hostTurnId,
  );
  if (sourceBoundaryIndex < 0 || derived.record.turnMappings.length !== sourceBoundaryIndex + 1) {
    return {
      ok: false,
      error: {
        code: -32076,
        message: "External rollback requires an untouched Fork-derived Thread",
      },
    };
  }
  const excludedActiveTurnCount =
    source.running || source.record.turnMappings.length > derived.record.turnMappings.length
      ? 1
      : 0;
  const retainedCount =
    derived.record.turnMappings.length - rollback.numTurns + excludedActiveTurnCount;
  if (retainedCount === derived.record.turnMappings.length) {
    return { ok: true, thread: derived.thread };
  }
  const boundary = source.record.turnMappings[retainedCount - 1];
  if (retainedCount < 1 || !boundary?.nativeCheckpointRef) {
    return {
      ok: false,
      error: { code: -32080, message: "External Fork Checkpoint is unavailable" },
    };
  }
  const sourceNativeRef = source.record.nativeSessionRef;
  const adapter = adapters.get(source.harnessId);
  if (!sourceNativeRef || !adapter) {
    return {
      ok: false,
      error: { code: -32079, message: "External Native Session is unavailable" },
    };
  }

  let opened: Awaited<ReturnType<HarnessAdapter["open"]>>;
  let executionPolicy: HarnessExecutionPolicy;
  try {
    executionPolicy = await repository.executionPolicyForThread(derived.record);
    opened = await adapter.open({
      kind: "fork",
      cwd: derived.cwd,
      environment: {
        ...(input.environment ?? process.env),
        [DELEGATION_THREAD_ID_ENV]: derived.id,
      },
      sourceRef: sourceNativeRef as NativeSessionRef,
      checkpoint: boundary.nativeCheckpointRef as NativeCheckpointRef,
      executionPolicy,
    });
  } catch {
    return { ok: false, error: { code: -32076, message: "External Thread fork failed" } };
  }
  if (!opened.ok) {
    return { ok: false, error: mapExternalThreadHarnessError(opened.error, "fork") };
  }

  const session = opened.value;
  const finalNativeRef = session.initialState.nativeRef;
  if (
    !finalNativeRef ||
    finalNativeRef.nativeSessionId === sourceNativeRef.nativeSessionId ||
    finalNativeRef.nativeSessionId === derived.record.nativeSessionRef?.nativeSessionId
  ) {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      error: { code: -32076, message: "External rollback did not create a distinct Session" },
    };
  }
  const snapshot = await session.readSnapshot();
  if (!snapshot.ok) {
    await session.close().catch(() => undefined);
    return { ok: false, error: mapExternalThreadHarnessError(snapshot.error, "read") };
  }
  if (snapshot.value.turns.length !== retainedCount) {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      error: { code: -32080, message: "External Fork result does not match the rollback boundary" },
    };
  }

  let aligned;
  try {
    aligned = await repository.commitForkRollback(
      derived.record,
      source.record,
      finalNativeRef as NativeSessionRef,
      snapshot.value,
    );
  } catch {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      error: { code: -32081, message: "External rollback could not be persisted" },
    };
  }
  const thread = externalThreadValue({
    record: aligned.record,
    turns: aligned.turns,
    sessionId: derived.sessionId,
  });
  await runtime.replace(derived, {
    record: aligned.record,
    session,
    sessionId: derived.sessionId,
    thread,
    turns: aligned.turns,
  });
  return { ok: true, thread };
}
