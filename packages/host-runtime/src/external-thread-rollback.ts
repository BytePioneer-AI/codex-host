import type {
  HarnessAdapter,
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

/**
 * Replace the current Session with one that keeps only the first `retainedCount` Turns.
 * Removing just the last Turn uses the native last-Turn rollback when available; removing
 * more Turns derives the replacement from the Checkpoint of the last retained Turn.
 */
async function executeCurrentRollback(input: {
  current: ExternalThread;
  retainedCount: number;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  environment?: NodeJS.ProcessEnv;
}): Promise<ExternalThreadRollbackResult> {
  const { current, retainedCount, adapters, repository, runtime } = input;
  // Keep the preparation version even if another Host operation replaces current.record.
  const currentRecord = current.record;
  if (retainedCount < 0 || retainedCount >= currentRecord.turnMappings.length) {
    return {
      ok: false,
      error: { code: -32076, message: "External Thread has no Turn to roll back" },
    };
  }
  const currentNativeRef = currentRecord.nativeSessionRef;
  const adapter = adapters.get(current.harnessId);
  if (!currentNativeRef || !adapter) {
    return {
      ok: false,
      error: { code: -32079, message: "External Native Session is unavailable" },
    };
  }
  const history = current.session.capabilities.history;
  const lastTurnOnly =
    retainedCount === currentRecord.turnMappings.length - 1 && history.rollbackLastTurn;
  const boundary = lastTurnOnly ? undefined : currentRecord.turnMappings[retainedCount - 1];
  if (!lastTurnOnly) {
    if (!history.fork) {
      return {
        ok: false,
        error: { code: -32076, message: "External Harness cannot roll back multiple Turns" },
      };
    }
    if (
      !boundary?.nativeCheckpointRef ||
      boundary.nativeCheckpointRef.nativeSessionId !== currentNativeRef.nativeSessionId
    ) {
      return {
        ok: false,
        error: { code: -32080, message: "External Fork Checkpoint is unavailable" },
      };
    }
  }

  const configuration = currentConfiguration(current);
  const environment = {
    ...(input.environment ?? process.env),
    [DELEGATION_THREAD_ID_ENV]: current.id,
  };
  let opened: Awaited<ReturnType<HarnessAdapter["open"]>>;
  try {
    opened = boundary?.nativeCheckpointRef
      ? await adapter.open({
          kind: "fork",
          cwd: current.cwd,
          environment,
          sourceRef: currentNativeRef as NativeSessionRef,
          checkpoint: boundary.nativeCheckpointRef as NativeCheckpointRef,
        })
      : await adapter.open({
          kind: "rollbackLastTurn",
          cwd: current.cwd,
          environment,
          sourceRef: currentNativeRef as NativeSessionRef,
          ...(configuration.effectiveModel ? { model: configuration.effectiveModel } : {}),
          ...(configuration.effectiveThinkingOptionId
            ? { thinkingOptionId: configuration.effectiveThinkingOptionId }
            : {}),
          ...(configuration.effectivePermissionModeId
            ? { permissionModeId: configuration.effectivePermissionModeId }
            : {}),
        });
  } catch {
    return { ok: false, error: { code: -32076, message: "External Thread rollback failed" } };
  }
  if (!opened.ok) {
    return { ok: false, error: mapExternalThreadHarnessError(opened.error, "fork") };
  }

  const session = opened.value;
  const finalNativeRef = session.initialState.nativeRef;
  if (
    !finalNativeRef ||
    finalNativeRef.harnessId !== current.harnessId ||
    (boundary && finalNativeRef.nativeSessionId === currentNativeRef.nativeSessionId)
  ) {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      error: { code: -32076, message: "External rollback did not return a valid Session" },
    };
  }
  const configurationError = await restoreCurrentConfiguration(session, configuration);
  if (configurationError) {
    await session.close().catch(() => undefined);
    return { ok: false, error: configurationError };
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
      error: { code: -32080, message: "External rollback did not keep the expected Turns" },
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
      currentRecord,
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
  /** Revert this Turn and every later Turn instead of `rollback.numTurns`. */
  revertBeforeTurnId?: HostTurnId;
  environment?: NodeJS.ProcessEnv;
}): Promise<ExternalThreadRollbackResult> {
  const { derived, rollback, adapters, repository, runtime, revertBeforeTurnId } = input;
  if (derived.running) {
    return { ok: false, error: { code: -32072, message: "External Thread has an active Turn" } };
  }
  const refreshError = await runtime.refresh(derived);
  if (refreshError) return { ok: false, error: refreshError };
  let numTurns = rollback.numTurns;
  if (revertBeforeTurnId !== undefined) {
    const index = derived.record.turnMappings.findIndex(
      ({ hostTurnId }) => hostTurnId === revertBeforeTurnId,
    );
    if (index < 0) {
      return {
        ok: false,
        error: { code: -32080, message: "External Revert boundary is unavailable" },
      };
    }
    numTurns = derived.record.turnMappings.length - index;
  }
  const currentRollback = () =>
    executeCurrentRollback({
      current: derived,
      retainedCount: derived.record.turnMappings.length - numTurns,
      adapters,
      repository,
      runtime,
      ...(input.environment ? { environment: input.environment } : {}),
    });
  if (numTurns === 1 && derived.session.capabilities.history.rollbackLastTurn) {
    return currentRollback();
  }

  const derivedRecord = derived.record;
  const forkSource = derivedRecord.forkSource;
  if (!forkSource) {
    return derived.session.capabilities.history.fork
      ? currentRollback()
      : {
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

  const sourceRecord = source.record;
  const sourceBoundaryIndex = sourceRecord.turnMappings.findIndex(
    ({ hostTurnId }) => hostTurnId === forkSource.hostTurnId,
  );
  if (sourceBoundaryIndex < 0 || derivedRecord.turnMappings.length !== sourceBoundaryIndex + 1) {
    // The Thread continued after its Fork, so its own Checkpoints describe its history.
    return derived.session.capabilities.history.fork
      ? currentRollback()
      : {
          ok: false,
          error: {
            code: -32076,
            message: "External rollback requires an untouched Fork-derived Thread",
          },
        };
  }
  const excludedActiveTurnCount =
    source.running || sourceRecord.turnMappings.length > derivedRecord.turnMappings.length ? 1 : 0;
  const retainedCount = derivedRecord.turnMappings.length - numTurns + excludedActiveTurnCount;
  if (retainedCount === derivedRecord.turnMappings.length) {
    return { ok: true, thread: derived.thread };
  }
  const boundary = sourceRecord.turnMappings[retainedCount - 1];
  if (retainedCount < 1 || !boundary?.nativeCheckpointRef) {
    return {
      ok: false,
      error: { code: -32080, message: "External Fork Checkpoint is unavailable" },
    };
  }
  const sourceNativeRef = sourceRecord.nativeSessionRef;
  const adapter = adapters.get(source.harnessId);
  if (!sourceNativeRef || !adapter) {
    return {
      ok: false,
      error: { code: -32079, message: "External Native Session is unavailable" },
    };
  }

  let opened: Awaited<ReturnType<HarnessAdapter["open"]>>;
  try {
    opened = await adapter.open({
      kind: "fork",
      cwd: derived.cwd,
      environment: {
        ...(input.environment ?? process.env),
        [DELEGATION_THREAD_ID_ENV]: derived.id,
      },
      sourceRef: sourceNativeRef as NativeSessionRef,
      checkpoint: boundary.nativeCheckpointRef as NativeCheckpointRef,
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
    finalNativeRef.nativeSessionId === derivedRecord.nativeSessionRef?.nativeSessionId
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
      derivedRecord,
      sourceRecord,
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
