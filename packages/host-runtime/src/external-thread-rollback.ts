import { isDeepStrictEqual } from "node:util";

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
import type {
  ExternalThread,
  ExternalThreadHistoryMutation,
  ExternalThreadHistoryReplacement,
  ExternalThreadRuntime,
} from "./external-thread-runtime.js";

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

function replacementState(
  session: HarnessSession,
  snapshotState: HarnessSessionState | undefined,
  nativeRef: NativeSessionRef,
): HarnessSessionState | null {
  const state = { ...session.initialState, ...snapshotState };
  return state.nativeRef && isDeepStrictEqual(state.nativeRef, nativeRef) ? state : null;
}

async function restoreCurrentConfiguration(
  session: HarnessSession,
  configuration: HarnessSessionState,
): Promise<ExternalThreadRpcError | null> {
  // Fixed settings need no selection command. The replacement snapshot below
  // must still report the exact current configuration before it can be committed.
  if (configuration.effectiveModel && session.capabilities.configuration.selectModel) {
    const selected = await session.execute({
      type: "model.select",
      model: configuration.effectiveModel,
    });
    if (!selected.ok) return mapExternalThreadHarnessError(selected.error, "fork");
  }
  if (
    configuration.effectiveThinkingOptionId &&
    session.capabilities.configuration.selectThinkingOption
  ) {
    const selected = await session.execute({
      type: "thinking.select",
      thinkingOptionId: configuration.effectiveThinkingOptionId,
    });
    if (!selected.ok) return mapExternalThreadHarnessError(selected.error, "fork");
  }
  if (
    configuration.effectivePermissionModeId &&
    session.capabilities.configuration.selectPermissionMode &&
    !permissionModeFixedAtCreate(session.capabilities.configuration)
  ) {
    const selected = await session.execute({
      type: "permissionMode.select",
      permissionModeId: configuration.effectivePermissionModeId,
    });
    if (!selected.ok) return mapExternalThreadHarnessError(selected.error, "fork");
  }
  return null;
}

async function discardReplacement(
  runtime: ExternalThreadRuntime,
  replacement: ExternalThreadHistoryReplacement,
): Promise<void> {
  await runtime.discardHistoryReplacement(replacement);
}

async function executeCurrentLastTurnRollback(input: {
  current: ExternalThread;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  mutation: ExternalThreadHistoryMutation;
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
  const configuration = currentConfiguration(current);

  let opened: Awaited<ReturnType<HarnessAdapter["open"]>>;
  try {
    opened = await adapter.open({
      kind: "rollbackLastTurn",
      cwd: current.cwd,
      environment: {
        ...(input.environment ?? process.env),
        [DELEGATION_THREAD_ID_ENV]: current.id,
      },
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
  if (!finalNativeRef || finalNativeRef.harnessId !== current.harnessId) {
    await runtime.closeUnownedSession(session, finalNativeRef);
    return {
      ok: false,
      error: { code: -32076, message: "External rollback did not return a valid Session" },
    };
  }
  if (session.capabilities.history.replacementFence !== true) {
    await runtime.closeUnownedSession(session, finalNativeRef);
    return {
      ok: false,
      error: {
        code: -32076,
        message: "External rollback returned a Session without a history replacement fence",
      },
    };
  }
  const replacement = runtime.reserveHistoryReplacement(
    current,
    input.mutation,
    session,
    finalNativeRef,
  );
  if (!replacement) {
    const owned = runtime.isSessionOwned(session, finalNativeRef);
    await runtime.closeUnownedSession(session, finalNativeRef);
    return {
      ok: false,
      error: owned
        ? { code: -32076, message: "External rollback did not return a distinct Session" }
        : { code: -32072, message: "External Thread changed during rollback" },
    };
  }
  let configurationError: ExternalThreadRpcError | null;
  try {
    configurationError = await restoreCurrentConfiguration(session, configuration);
  } catch {
    await discardReplacement(runtime, replacement);
    return {
      ok: false,
      error: { code: -32076, message: "External rollback could not restore configuration" },
    };
  }
  if (configurationError) {
    await discardReplacement(runtime, replacement);
    return { ok: false, error: configurationError };
  }
  let snapshot: Awaited<ReturnType<HarnessSession["readSnapshot"]>>;
  try {
    snapshot = await session.readSnapshot();
  } catch {
    await discardReplacement(runtime, replacement);
    return { ok: false, error: { code: -32076, message: "External rollback history read failed" } };
  }
  if (!snapshot.ok) {
    await discardReplacement(runtime, replacement);
    return { ok: false, error: mapExternalThreadHarnessError(snapshot.error, "read") };
  }
  if (snapshot.value.turns.length !== current.record.turnMappings.length - 1) {
    await discardReplacement(runtime, replacement);
    return {
      ok: false,
      error: { code: -32080, message: "External rollback did not remove exactly one Turn" },
    };
  }
  const restoredState = replacementState(
    session,
    snapshot.value.state,
    finalNativeRef as NativeSessionRef,
  );
  if (!restoredState) {
    await discardReplacement(runtime, replacement);
    return {
      ok: false,
      error: { code: -32080, message: "External rollback changed Native Session identity" },
    };
  }
  if (!sameCurrentConfiguration(configuration, restoredState)) {
    await discardReplacement(runtime, replacement);
    return {
      ok: false,
      error: { code: -32080, message: "External rollback changed configuration" },
    };
  }

  const commitPreparationError = await runtime.prepareHistoryCommit(
    current,
    input.mutation,
    replacement,
  );
  if (commitPreparationError) {
    await discardReplacement(runtime, replacement);
    return { ok: false, error: commitPreparationError };
  }

  let aligned;
  try {
    aligned = await repository.commitLastTurnRollback(
      current.record,
      finalNativeRef as NativeSessionRef,
      snapshot.value,
    );
  } catch {
    await discardReplacement(runtime, replacement);
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
  // The committed Mapping Store record now owns this replacement Native Session.
  // Runtime replacement has been preflighted under the same mutation reservation.
  await runtime.replace(
    current,
    {
      record: aligned.record,
      session,
      sessionId: current.sessionId,
      thread,
      turns: aligned.turns,
      restoredState,
    },
    input.mutation,
    replacement,
  );
  return { ok: true, thread };
}

export async function executeExternalThreadRollback(input: {
  derived: ExternalThread;
  rollback: DecodedThreadRollbackRequest;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  expectedLastTurnId?: HostTurnId;
  hasRunningSubagents?: (threadId: string) => boolean;
  environment?: NodeJS.ProcessEnv;
}): Promise<ExternalThreadRollbackResult> {
  const { derived, rollback, adapters, repository, runtime, expectedLastTurnId } = input;
  if (derived.running || derived.activeTurnId || input.hasRunningSubagents?.(derived.id) === true) {
    return { ok: false, error: { code: -32072, message: "External Thread has an active Turn" } };
  }
  if (expectedLastTurnId === undefined) {
    const refreshError = await runtime.refresh(derived);
    if (refreshError) return { ok: false, error: refreshError };
  }
  if (derived.running || derived.activeTurnId || input.hasRunningSubagents?.(derived.id) === true) {
    return { ok: false, error: { code: -32072, message: "External Thread has an active Turn" } };
  }
  if (
    expectedLastTurnId !== undefined &&
    derived.record.turnMappings.at(-1)?.hostTurnId !== expectedLastTurnId
  ) {
    return {
      ok: false,
      error: { code: -32080, message: "External Revert boundary is unavailable" },
    };
  }
  if (expectedLastTurnId !== undefined && !derived.session.capabilities.history.rollbackLastTurn) {
    return {
      ok: false,
      error: { code: -32076, message: "External Harness cannot safely edit the latest message" },
    };
  }
  if (derived.session.capabilities.history.replacementFence !== true) {
    return {
      ok: false,
      error: {
        code: -32076,
        message: "External Harness cannot fence Native activity for history replacement",
      },
    };
  }
  const mutation = runtime.beginHistoryMutation(derived);
  if (!mutation) {
    return { ok: false, error: { code: -32072, message: "External Thread has an active Turn" } };
  }
  try {
    if (rollback.numTurns === 1 && derived.session.capabilities.history.rollbackLastTurn) {
      return await executeCurrentLastTurnRollback({
        current: derived,
        adapters,
        repository,
        runtime,
        mutation,
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
    const configuration = currentConfiguration(derived);

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
    if (!finalNativeRef || finalNativeRef.harnessId !== derived.harnessId) {
      await runtime.closeUnownedSession(session, finalNativeRef);
      return {
        ok: false,
        error: { code: -32076, message: "External rollback did not create a distinct Session" },
      };
    }
    if (session.capabilities.history.replacementFence !== true) {
      await runtime.closeUnownedSession(session, finalNativeRef);
      return {
        ok: false,
        error: {
          code: -32076,
          message: "External rollback returned a Session without a history replacement fence",
        },
      };
    }
    const replacement = runtime.reserveHistoryReplacement(
      derived,
      mutation,
      session,
      finalNativeRef,
    );
    if (!replacement) {
      const owned = runtime.isSessionOwned(session, finalNativeRef);
      await runtime.closeUnownedSession(session, finalNativeRef);
      return {
        ok: false,
        error: owned
          ? { code: -32076, message: "External rollback did not create a distinct Session" }
          : { code: -32072, message: "External Thread changed during rollback" },
      };
    }
    let configurationError: ExternalThreadRpcError | null;
    try {
      configurationError = await restoreCurrentConfiguration(session, configuration);
    } catch {
      await discardReplacement(runtime, replacement);
      return {
        ok: false,
        error: { code: -32076, message: "External rollback could not restore configuration" },
      };
    }
    if (configurationError) {
      await discardReplacement(runtime, replacement);
      return { ok: false, error: configurationError };
    }
    let snapshot: Awaited<ReturnType<HarnessSession["readSnapshot"]>>;
    try {
      snapshot = await session.readSnapshot();
    } catch {
      await discardReplacement(runtime, replacement);
      return {
        ok: false,
        error: { code: -32076, message: "External rollback history read failed" },
      };
    }
    if (!snapshot.ok) {
      await discardReplacement(runtime, replacement);
      return { ok: false, error: mapExternalThreadHarnessError(snapshot.error, "read") };
    }
    if (snapshot.value.turns.length !== retainedCount) {
      await discardReplacement(runtime, replacement);
      return {
        ok: false,
        error: {
          code: -32080,
          message: "External Fork result does not match the rollback boundary",
        },
      };
    }
    const restoredState = replacementState(
      session,
      snapshot.value.state,
      finalNativeRef as NativeSessionRef,
    );
    if (!restoredState) {
      await discardReplacement(runtime, replacement);
      return {
        ok: false,
        error: { code: -32080, message: "External rollback changed Native Session identity" },
      };
    }
    if (!sameCurrentConfiguration(configuration, restoredState)) {
      await discardReplacement(runtime, replacement);
      return {
        ok: false,
        error: { code: -32080, message: "External rollback changed configuration" },
      };
    }
    const commitPreparationError = await runtime.prepareHistoryCommit(
      derived,
      mutation,
      replacement,
    );
    if (commitPreparationError) {
      await discardReplacement(runtime, replacement);
      return { ok: false, error: commitPreparationError };
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
      await discardReplacement(runtime, replacement);
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
    await runtime.replace(
      derived,
      {
        record: aligned.record,
        session,
        sessionId: derived.sessionId,
        thread,
        turns: aligned.turns,
        restoredState,
      },
      mutation,
      replacement,
    );
    return { ok: true, thread };
  } finally {
    runtime.endHistoryMutation(derived, mutation);
  }
}
