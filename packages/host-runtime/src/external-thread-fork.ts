import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  mapExternalThreadHarnessError,
  type DecodedThreadForkRequest,
  type ExternalHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import type { NativeCheckpointRef, NativeSessionRef } from "@codexhost/shared-contracts";

import {
  createExternalThreadRecordInput,
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";

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
}): Promise<ExternalThreadForkResult> {
  const { source, fork, adapters, repository, runtime } = input;
  if (source.running) {
    return { ok: false, error: { code: -32072, message: "External Thread has an active Turn" } };
  }
  if (
    fork.path ||
    (fork.cwd !== undefined && fork.cwd !== source.cwd) ||
    (fork.model !== undefined && fork.model !== source.transportModelId) ||
    (fork.modelProvider !== undefined && fork.modelProvider !== "codexhost")
  ) {
    return {
      ok: false,
      error: {
        code: -32602,
        message: "External Fork cannot override source ownership or location",
      },
    };
  }
  if (!source.session.capabilities.history.fork) {
    return {
      ok: false,
      error: { code: -32076, message: "External Harness does not support fork" },
    };
  }
  const refreshError = await runtime.refresh(source);
  if (refreshError) return { ok: false, error: refreshError };

  const mappings = source.record.turnMappings;
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
        cwd: source.cwd,
        transportModelId: source.transportModelId,
        ephemeral: fork.ephemeral ?? source.record.ephemeral,
        historyMode: source.record.historyMode,
        forkSource: {
          hostThreadId: source.id,
          hostTurnId: boundary.hostTurnId,
        },
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
      cwd: source.cwd,
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
    const aligned = await repository.commitDerivedSnapshot(
      provisional,
      derivedNativeRef as NativeSessionRef,
      snapshot.value,
    );
    const thread = externalThreadValue({
      record: aligned.record,
      turns: aligned.turns,
      sessionId: source.sessionId,
    });
    const derived = runtime.register({
      record: aligned.record,
      session,
      sessionId: source.sessionId,
      thread,
      turns: aligned.turns,
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
