import nodePath from "node:path";

import type { HarnessAdapter, HarnessSession } from "@codexhost/harness-adapter";
import {
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  mapExternalThreadHarnessError,
  type DecodedThreadForkRequest,
  type ExternalHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  permissionModeFixedAtCreate,
  type HarnessPermissionModeId,
  type NativeCheckpointRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  createExternalThreadRecordInput,
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import { DELEGATION_THREAD_ID_ENV } from "./delegation-types.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";
import { ownTurns } from "./external-thread-side-chat.js";

export type ExternalThreadForkResult =
  | { ok: false; error: ExternalThreadRpcError }
  | {
      ok: true;
      derived: ExternalThread;
      thread: JsonObject;
      responseThread: JsonObject;
    };

export async function executeExternalThreadFork(input: {
  source: ExternalThread;
  fork: DecodedThreadForkRequest;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  environment?: NodeJS.ProcessEnv;
}): Promise<ExternalThreadForkResult> {
  const { source, fork, adapters, repository, runtime } = input;
  const targetCwd = fork.cwd ?? source.cwd;
  const changesCwd = targetCwd !== source.cwd;
  if (
    fork.path ||
    (fork.model !== undefined && fork.model !== source.transportModelId) ||
    (fork.modelProvider !== undefined && fork.modelProvider !== "codexhost")
  ) {
    return {
      ok: false,
      error: { code: -32602, message: "External Fork cannot override source ownership" },
    };
  }
  if (
    changesCwd &&
    (!nodePath.isAbsolute(targetCwd) ||
      (fork.runtimeWorkspaceRoots !== undefined &&
        (fork.runtimeWorkspaceRoots.some((root) => !nodePath.isAbsolute(root)) ||
          !fork.runtimeWorkspaceRoots.includes(targetCwd))))
  ) {
    return {
      ok: false,
      error: { code: -32602, message: "External Fork target cwd is invalid" },
    };
  }
  if (fork.attachToSource && source.record.historyMode !== "paginated") {
    return {
      ok: false,
      error: { code: -32602, message: "attachToSource requires a paginated parent" },
    };
  }
  // A persistent Side Chat cannot outlive an ephemeral source it is listed under.
  if (fork.attachToSource && source.record.ephemeral) {
    return {
      ok: false,
      error: { code: -32602, message: "attachToSource requires a persistent parent" },
    };
  }
  if (!source.session.capabilities.history.fork) {
    return {
      ok: false,
      error: { code: -32076, message: "External Harness does not support fork" },
    };
  }
  if (changesCwd && !source.session.capabilities.history.forkAcrossCwd) {
    return {
      ok: false,
      error: { code: -32076, message: "External Harness cannot fork into another cwd" },
    };
  }
  if (!source.running) {
    const refreshError = await runtime.refresh(source);
    if (refreshError) return { ok: false, error: refreshError };
  }

  const mappings = source.record.turnMappings;
  // Desktop opens a Side Chat as an attached or ephemeral fork without a boundary Turn. As in
  // native Codex it carries completed history only, so before the source completes a Turn it
  // starts a new Native Session. Other forks still need a completed Turn's Native Checkpoint.
  if (
    (fork.attachToSource || fork.ephemeral) &&
    mappings.length === 0 &&
    !fork.lastTurnId &&
    !fork.beforeTurnId
  ) {
    return forkWithoutHistory({ ...input, cwd: targetCwd });
  }
  let boundaryIndex: number;
  if (fork.lastTurnId) {
    boundaryIndex = mappings.findIndex(({ hostTurnId }) => hostTurnId === fork.lastTurnId);
  } else if (fork.beforeTurnId) {
    const beforeIndex = mappings.findIndex(({ hostTurnId }) => hostTurnId === fork.beforeTurnId);
    boundaryIndex = beforeIndex < 0 ? -2 : beforeIndex - 1;
  } else {
    boundaryIndex = mappings.length - 1;
  }
  const boundary = mappings[boundaryIndex];
  // Native history may have split this boundary Turn while Desktop still shows it whole.
  if (boundary && source.steeredTurnIds.has(boundary.hostTurnId)) {
    return {
      ok: false,
      error: {
        code: -32080,
        message: "This Turn took steered input; reopen the Thread before forking from it",
      },
    };
  }
  if (boundaryIndex < 0 || !boundary?.nativeCheckpointRef) {
    return {
      ok: false,
      error: { code: -32080, message: "External Fork Checkpoint is unavailable" },
    };
  }
  const nativeSessionRef = source.record.nativeSessionRef;
  const adapter = adapters.get(source.harnessId);
  if (!nativeSessionRef || !adapter) {
    return {
      ok: false,
      error: { code: -32079, message: "External Native Session is unavailable" },
    };
  }

  let provisional;
  try {
    provisional = await repository.createProvisional(
      createExternalThreadRecordInput({
        harnessId: source.record.harnessId,
        cwd: targetCwd,
        transportModelId: source.transportModelId,
        ephemeral: fork.ephemeral ?? source.record.ephemeral,
        historyMode: source.record.historyMode,
        forkSource: {
          hostThreadId: source.id,
          hostTurnId: boundary.hostTurnId,
        },
        // A persistent Side Chat: the source's history up to the boundary stays as context only.
        ...(fork.attachToSource
          ? { attachedToThreadId: source.id, inheritedTurnCount: boundaryIndex + 1 }
          : {}),
      }),
    );
  } catch {
    return {
      ok: false,
      error: { code: -32081, message: "External Fork could not be persisted" },
    };
  }

  let opened: Awaited<ReturnType<HarnessAdapter["open"]>>;
  try {
    opened = await adapter.open({
      kind: "fork",
      cwd: targetCwd,
      environment: {
        ...(input.environment ?? process.env),
        [DELEGATION_THREAD_ID_ENV]: provisional.hostThreadId,
      },
      sourceRef: nativeSessionRef as NativeSessionRef,
      checkpoint: boundary.nativeCheckpointRef as NativeCheckpointRef,
    });
  } catch {
    await repository.removeProvisional(provisional.hostThreadId).catch(() => undefined);
    return { ok: false, error: { code: -32076, message: "External Thread fork failed" } };
  }
  if (!opened.ok) {
    await repository.removeProvisional(provisional.hostThreadId).catch(() => undefined);
    return { ok: false, error: mapExternalThreadHarnessError(opened.error, "fork") };
  }

  const session = opened.value;
  await inheritSourceModel(source, session);
  const inheritedPermissionModeId = await inheritSourcePermissionMode(source, session);
  try {
    const derivedNativeRef = session.initialState.nativeRef;
    if (
      !derivedNativeRef ||
      derivedNativeRef.nativeSessionId === nativeSessionRef.nativeSessionId
    ) {
      throw new Error("External Fork did not create a distinct Native Session");
    }
    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) {
      await session.close().catch(() => undefined);
      await repository.removeProvisional(provisional.hostThreadId).catch(() => undefined);
      return { ok: false, error: mapExternalThreadHarnessError(snapshot.error, "read") };
    }
    // Persist the derived Session's actual Model, not a source-only runtime selection.
    // Do this while provisional so a persistence failure still removes the entire Fork.
    const effectiveModel = snapshot.value.state?.effectiveModel;
    const selection = decodeExternalTransportSelection(
      source.harnessId,
      provisional.transportModelId,
    );
    if (effectiveModel && selection && selection.model?.id !== effectiveModel.id) {
      const transportModelId = encodeExternalTransportSelection(source.harnessId, {
        ...selection,
        model: effectiveModel,
      });
      provisional = await repository.setTransportModelId(
        provisional.hostThreadId,
        transportModelId,
      );
    }
    const aligned = await repository.commitDerivedSnapshot(
      provisional,
      derivedNativeRef as NativeSessionRef,
      snapshot.value,
    );
    // A Side Chat lists only its own Turns; the runtime keeps the inherited ones as context.
    const thread = externalThreadValue({
      record: aligned.record,
      turns: ownTurns(aligned.record, aligned.turns),
      sessionId: source.sessionId,
    });
    const derived = runtime.register({
      record: aligned.record,
      session,
      sessionId: source.sessionId,
      thread,
      turns: aligned.turns,
      ...(snapshot.value.state ? { restoredState: snapshot.value.state } : {}),
      ...(inheritedPermissionModeId
        ? { requestedPermissionModeId: inheritedPermissionModeId }
        : {}),
    });
    return {
      ok: true,
      derived,
      thread,
      responseThread: fork.excludeTurns ? { ...thread, turns: [] } : thread,
    };
  } catch {
    runtime.remove(provisional.hostThreadId);
    await session.close().catch(() => undefined);
    await repository.removeProvisional(provisional.hostThreadId).catch(() => undefined);
    return {
      ok: false,
      error: { code: -32081, message: "External Fork could not be persisted" },
    };
  }
}

/**
 * A Side Chat opened before its source completes a Turn, such as during the source's first
 * Turn: a new Native Session of the source Harness, with the source's current Model, Thinking
 * and Permission Mode.
 */
async function forkWithoutHistory(input: {
  source: ExternalThread;
  fork: DecodedThreadForkRequest;
  cwd: string;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  environment?: NodeJS.ProcessEnv;
}): Promise<ExternalThreadForkResult> {
  const { source, fork, cwd, repository, runtime } = input;
  const adapter = input.adapters.get(source.harnessId);
  if (!adapter) {
    return {
      ok: false,
      error: { code: -32070, message: `External Harness '${source.harnessId}' is unavailable` },
    };
  }
  let record;
  try {
    record = await repository.createProvisional(
      createExternalThreadRecordInput({
        harnessId: source.record.harnessId,
        cwd,
        transportModelId: source.transportModelId,
        ephemeral: fork.ephemeral ?? source.record.ephemeral,
        historyMode: source.record.historyMode,
        ...(fork.attachToSource ? { attachedToThreadId: source.id, inheritedTurnCount: 0 } : {}),
      }),
    );
  } catch {
    return {
      ok: false,
      error: { code: -32081, message: "External Fork could not be persisted" },
    };
  }
  let persisted;
  try {
    persisted = decodeExternalTransportSelection(source.harnessId, source.transportModelId);
  } catch {
    persisted = null;
  }
  const state = source.stateObserver.state;
  const model = state.effectiveModel ?? source.requestedModel ?? persisted?.model;
  const thinkingOptionId =
    state.effectiveThinkingOptionId ??
    source.requestedThinkingOptionId ??
    persisted?.thinkingOptionId;
  const permissionModeId =
    state.effectivePermissionModeId ??
    source.requestedPermissionModeId ??
    persisted?.permissionModeId;
  let opened: Awaited<ReturnType<HarnessAdapter["open"]>>;
  try {
    opened = await adapter.open({
      kind: "create",
      cwd,
      environment: {
        ...(input.environment ?? process.env),
        [DELEGATION_THREAD_ID_ENV]: record.hostThreadId,
      },
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    });
  } catch {
    await repository.removeProvisional(record.hostThreadId).catch(() => undefined);
    return { ok: false, error: { code: -32076, message: "External Thread fork failed" } };
  }
  if (!opened.ok) {
    await repository.removeProvisional(record.hostThreadId).catch(() => undefined);
    return { ok: false, error: mapExternalThreadHarnessError(opened.error, "create") };
  }
  const session = opened.value;
  try {
    if (session.initialState.nativeRef) {
      record = await repository.commitNative(record.hostThreadId, session.initialState.nativeRef);
    }
    const thread = externalThreadValue({ record, turns: [], sessionId: record.hostThreadId });
    const derived = runtime.register({
      record,
      session,
      sessionId: record.hostThreadId,
      thread,
      turns: [],
      ...(model ? { requestedModel: model } : {}),
      ...(thinkingOptionId ? { requestedThinkingOptionId: thinkingOptionId } : {}),
      ...(permissionModeId ? { requestedPermissionModeId: permissionModeId } : {}),
    });
    return { ok: true, derived, thread, responseThread: thread };
  } catch {
    runtime.remove(record.hostThreadId);
    await session.close().catch(() => undefined);
    await repository.removeProvisional(record.hostThreadId).catch(() => undefined);
    return {
      ok: false,
      error: { code: -32081, message: "External Fork could not be persisted" },
    };
  }
}

/**
 * A fork continues the source conversation. When the Harness does not confirm a Model for the
 * derived Session (Claude Code would otherwise run its native default), it keeps the source's
 * current Model. A Model the Harness confirms for the fork is its actual Model and stays.
 * Failure is non-fatal: the derived Session then keeps the Model it opened with.
 */
async function inheritSourceModel(source: ExternalThread, session: HarnessSession): Promise<void> {
  let persisted;
  try {
    persisted = decodeExternalTransportSelection(source.harnessId, source.transportModelId)?.model;
  } catch {
    persisted = undefined;
  }
  const sourceModel =
    source.stateObserver.state.effectiveModel ?? source.requestedModel ?? persisted;
  if (
    !sourceModel ||
    !session.capabilities.configuration.selectModel ||
    session.initialState.effectiveModel !== undefined
  ) {
    return;
  }
  try {
    await session.execute({ type: "model.select", model: sourceModel });
  } catch {
    // The derived Session keeps the Model it opened with.
  }
}

/**
 * A fork continues the source conversation, so it keeps the source's current Permission Mode
 * instead of silently dropping back to the Harness default. Failure is non-fatal: the derived
 * Session then keeps whatever mode the Harness opened it with.
 */
async function inheritSourcePermissionMode(
  source: ExternalThread,
  session: HarnessSession,
): Promise<HarnessPermissionModeId | undefined> {
  const sourceModeId =
    source.stateObserver.state.effectivePermissionModeId ?? source.requestedPermissionModeId;
  if (!sourceModeId) return undefined;
  const configuration = session.capabilities.configuration;
  if (!configuration.selectPermissionMode || permissionModeFixedAtCreate(configuration)) {
    return undefined;
  }
  try {
    const selected = await session.execute({
      type: "permissionMode.select",
      permissionModeId: sourceModeId,
    });
    return selected.ok ? sourceModeId : undefined;
  } catch {
    return undefined;
  }
}
