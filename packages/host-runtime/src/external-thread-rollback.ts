import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  mapExternalThreadHarnessError,
  type DecodedThreadRollbackRequest,
  type ExternalHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import type { NativeCheckpointRef, NativeSessionRef } from "@codexhost/shared-contracts";

import {
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";

export type ExternalThreadRollbackResult =
  { ok: false; error: ExternalThreadRpcError } | { ok: true; thread: JsonObject };

export async function executeExternalThreadRollback(input: {
  derived: ExternalThread;
  rollback: DecodedThreadRollbackRequest;
  adapters: Map<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
}): Promise<ExternalThreadRollbackResult> {
  const { derived, rollback, adapters, repository, runtime } = input;
  if (derived.running) {
    return { ok: false, error: { code: -32072, message: "External Thread has an active Turn" } };
  }
  const refreshError = await runtime.refresh(derived);
  if (refreshError) return { ok: false, error: refreshError };

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
  if (source.running) {
    return {
      ok: false,
      error: { code: -32072, message: "External Fork source has an active Turn" },
    };
  }
  if (
    source.id === derived.id ||
    source.harnessId !== derived.harnessId ||
    source.cwd !== derived.cwd ||
    !source.session.capabilities.history.fork
  ) {
    return {
      ok: false,
      error: { code: -32076, message: "External rollback source lineage is unsupported" },
    };
  }
  const sourceRefreshError = await runtime.refresh(source);
  if (sourceRefreshError) return { ok: false, error: sourceRefreshError };

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
  const retainedCount = derived.record.turnMappings.length - rollback.numTurns;
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
  try {
    opened = await adapter.open({
      kind: "fork",
      cwd: source.cwd,
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
