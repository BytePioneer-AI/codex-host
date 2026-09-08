import { isDeepStrictEqual } from "node:util";
import type {
  HarnessAdapter,
  HarnessSession,
  HarnessSessionState,
  HostThreadSnapshot,
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

import type { ExternalSessionLease } from "./external-session-access.js";

export type ExternalThreadRollbackResult =
  { ok: false; error: ExternalThreadRpcError } | { ok: true; thread: JsonObject };

function retainsHistory(
  source: HostThreadSnapshot | undefined,
  replacement: HostThreadSnapshot,
  count: number,
): boolean {
  const content = (snapshot: HostThreadSnapshot) =>
    snapshot.turns.map((turn) => ({
      input: turn.input,
      items: turn.items.map(({ item, outcome }) => ({
        item: { ...item, itemId: undefined },
        outcome,
      })),
      outcome: turn.outcome,
      hasCheckpoint: Boolean(turn.checkpoint),
      model: turn.model,
    }));
  return Boolean(
    source && isDeepStrictEqual(content(source).slice(0, count), content(replacement)),
  );
}

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
  lease: ExternalSessionLease;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  environment?: NodeJS.ProcessEnv;
}): Promise<ExternalThreadRollbackResult> {
  const { current, adapters, repository, runtime, lease } = input;
  // Keep the preparation version even if another Host operation replaces current.record.
  const currentRecord = current.record;
  if (currentRecord.turnMappings.length === 0) {
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
    session.harnessId !== current.harnessId
  ) {
    await runtime.closeUnownedCandidate(session, finalNativeRef);
    return {
      ok: false,
      error: { code: -32076, message: "External rollback did not return a valid Session" },
    };
  }
  const configuration = currentConfiguration(current);
  if (!runtime.reserveHistoryCandidate(current, lease, session, finalNativeRef)) {
    await runtime.closeUnownedCandidate(session, finalNativeRef);
    return {
      ok: false,
      error: { code: -32076, message: "External rollback candidate is already owned" },
    };
  }
  const configurationError = await restoreCurrentConfiguration(session, configuration);
  if (configurationError) {
    return { ok: false, error: configurationError };
  }
  const snapshot = await session.readSnapshot();
  if (!snapshot.ok) {
    return { ok: false, error: mapExternalThreadHarnessError(snapshot.error, "read") };
  }
  if (
    snapshot.value.turns.length !== currentRecord.turnMappings.length - 1 ||
    !retainsHistory(lease.snapshot, snapshot.value, currentRecord.turnMappings.length - 1)
  ) {
    return {
      ok: false,
      error: { code: -32080, message: "External rollback did not remove exactly one Turn" },
    };
  }
  const replacementState = { ...session.initialState, ...snapshot.value.state };
  if (
    !sameCurrentConfiguration(configuration, replacementState) ||
    !isDeepStrictEqual(replacementState.nativeRef, finalNativeRef)
  ) {
    return {
      ok: false,
      error: { code: -32080, message: "External rollback changed configuration" },
    };
  }

  const preparationError = await runtime.prepareHistoryCommit(current, lease, currentRecord);
  if (preparationError) return { ok: false, error: preparationError };
  let aligned;
  try {
    aligned = await repository.commitLastTurnRollback(
      currentRecord,
      finalNativeRef as NativeSessionRef,
      snapshot.value,
    );
  } catch {
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
  await runtime.replace(
    current,
    {
      record: aligned.record,
      session,
      sessionId: current.sessionId,
      thread,
      turns: aligned.turns,
      restoredState: replacementState,
    },
    lease,
  );
  return { ok: true, thread };
}

interface ExternalThreadRollbackInput {
  derived: ExternalThread;
  rollback: DecodedThreadRollbackRequest;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  expectedLastTurnId?: HostTurnId;
  environment?: NodeJS.ProcessEnv;
}

export async function executeExternalThreadRollback(
  input: ExternalThreadRollbackInput,
): Promise<ExternalThreadRollbackResult> {
  const lease = input.runtime.beginHistoryReplacement(input.derived);
  if (!lease) return { ok: false, error: { code: -32072, message: "External Session is busy" } };
  try {
    return await rollbackWithLease(input, lease);
  } catch {
    return { ok: false, error: { code: -32076, message: "External history replacement failed" } };
  } finally {
    await input.runtime.finishHistoryReplacement(input.derived, lease);
  }
}

async function rollbackWithLease(
  input: ExternalThreadRollbackInput,
  lease: ExternalSessionLease,
): Promise<ExternalThreadRollbackResult> {
  const { derived, rollback, adapters, repository, runtime, expectedLastTurnId } = input;
  if (derived.running) {
    return { ok: false, error: { code: -32072, message: "External Thread has an active Turn" } };
  }
  const refreshError = await runtime.refresh(derived, lease);
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
      lease,
      adapters,
      repository,
      runtime,
      ...(input.environment ? { environment: input.environment } : {}),
    });
  }

  const derivedRecord = derived.record;
  const forkSource = derivedRecord.forkSource;
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

  const sourceRecord = source.record;
  const sourceBoundaryIndex = sourceRecord.turnMappings.findIndex(
    ({ hostTurnId }) => hostTurnId === forkSource.hostTurnId,
  );
  if (sourceBoundaryIndex < 0 || derivedRecord.turnMappings.length !== sourceBoundaryIndex + 1) {
    return {
      ok: false,
      error: {
        code: -32076,
        message: "External rollback requires an untouched Fork-derived Thread",
      },
    };
  }
  const excludedActiveTurnCount =
    source.running || sourceRecord.turnMappings.length > derivedRecord.turnMappings.length ? 1 : 0;
  const retainedCount =
    derivedRecord.turnMappings.length - rollback.numTurns + excludedActiveTurnCount;
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
  if (
    !finalNativeRef ||
    finalNativeRef.harnessId !== derived.harnessId ||
    session.harnessId !== derived.harnessId ||
    finalNativeRef.nativeSessionId === sourceNativeRef.nativeSessionId ||
    finalNativeRef.nativeSessionId === derivedRecord.nativeSessionRef?.nativeSessionId
  ) {
    await runtime.closeUnownedCandidate(session, finalNativeRef);
    return {
      ok: false,
      error: { code: -32076, message: "External rollback did not create a distinct Session" },
    };
  }
  if (!runtime.reserveHistoryCandidate(derived, lease, session, finalNativeRef)) {
    await runtime.closeUnownedCandidate(session, finalNativeRef);
    return {
      ok: false,
      error: { code: -32076, message: "External rollback candidate is already owned" },
    };
  }
  const configurationError = await restoreCurrentConfiguration(session, configuration);
  if (configurationError) return { ok: false, error: configurationError };
  const snapshot = await session.readSnapshot();
  if (!snapshot.ok) {
    return { ok: false, error: mapExternalThreadHarnessError(snapshot.error, "read") };
  }
  if (
    snapshot.value.turns.length !== retainedCount ||
    !retainsHistory(lease.snapshot, snapshot.value, retainedCount)
  ) {
    return {
      ok: false,
      error: { code: -32080, message: "External Fork result does not match the rollback boundary" },
    };
  }

  const replacementState = { ...session.initialState, ...snapshot.value.state };
  if (
    !sameCurrentConfiguration(configuration, replacementState) ||
    !isDeepStrictEqual(replacementState.nativeRef, finalNativeRef)
  ) {
    return {
      ok: false,
      error: { code: -32080, message: "External rollback changed configuration" },
    };
  }
  const preparationError = await runtime.prepareHistoryCommit(derived, lease, derivedRecord);
  if (preparationError) return { ok: false, error: preparationError };
  let aligned;
  try {
    aligned = await repository.commitForkRollback(
      derivedRecord,
      sourceRecord,
      finalNativeRef as NativeSessionRef,
      snapshot.value,
    );
  } catch {
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
      restoredState: replacementState,
    },
    lease,
  );
  return { ok: true, thread };
}
