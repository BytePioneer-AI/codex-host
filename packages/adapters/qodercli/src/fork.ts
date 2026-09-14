import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { deleteSession, forkSession } from "@qoder-ai/qoder-agent-sdk";

import type {
  HarnessError,
  HarnessResult,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type NativeCheckpointRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { readQoderSnapshot } from "./history.js";

export interface QoderHistoryDependencies {
  readSnapshot(nativeRef: NativeSessionRef, cwd: string): Promise<HostThreadSnapshot>;
  forkSession(input: {
    sourceSessionId: string;
    cwd: string;
    upToMessageId?: string;
  }): Promise<{ sessionId: string }>;
  deleteSession(input: { sessionId: string; cwd: string }): Promise<void>;
}

export const defaultQoderHistoryDependencies: QoderHistoryDependencies = {
  readSnapshot: (nativeRef, cwd) => readQoderSnapshot(nativeRef, cwd),
  forkSession: (input) =>
    forkSession(input.sourceSessionId, {
      dir: input.cwd,
      ...(input.upToMessageId ? { upToMessageId: input.upToMessageId } : {}),
    }),
  deleteSession: (input) => deleteSession(input.sessionId, { dir: input.cwd }),
};

function error(code: HarnessError["code"], message: string, retryable: boolean): HarnessError {
  return { code, message, retryable };
}

function nativeIds(snapshot: HostThreadSnapshot): Set<string> {
  return new Set(
    snapshot.turns.flatMap((turn) => [
      turn.nativeTurnRef.nativeTurnKey,
      ...(turn.checkpoint ? [turn.checkpoint.checkpointId] : []),
    ]),
  );
}

function comparableTurn(turn: HostTurnSnapshot): unknown {
  return {
    input: turn.input,
    items: turn.items.map(({ item, outcome }) => ({
      item: { ...item, itemId: undefined },
      outcome,
    })),
    outcome: turn.outcome,
    hasCheckpoint: turn.checkpoint !== undefined,
    ...(turn.model ? { model: turn.model } : {}),
  };
}

export async function deriveQoderSession(input: {
  kind: "fork" | "rollbackLastTurn";
  cwd: string;
  sourceRef: NativeSessionRef;
  checkpoint?: NativeCheckpointRef;
  dependencies?: Partial<QoderHistoryDependencies>;
}): Promise<HarnessResult<{ sessionId: string; openMode: "create" | "resume" }>> {
  const dependencies = { ...defaultQoderHistoryDependencies, ...input.dependencies };
  const sourceRef = nativeSessionRefSchema.safeParse(input.sourceRef);
  if (!sourceRef.success) {
    return {
      ok: false,
      error: error("invalidRequest", "Qoder Session identity is invalid", false),
    };
  }
  const source = await dependencies.readSnapshot(sourceRef.data, input.cwd);
  if (input.kind === "rollbackLastTurn" && source.turns.length === 0) {
    return {
      ok: false,
      error: error("invalidRequest", "Qoder Session has no Turn to roll back", false),
    };
  }
  if (input.kind === "rollbackLastTurn" && source.turns.length === 1) {
    const emptySessionId = randomUUID();
    const sourceAfter = await dependencies.readSnapshot(sourceRef.data, input.cwd);
    if (!isDeepStrictEqual(sourceAfter, source)) {
      return {
        ok: false,
        error: error("protocolError", "Qoder source history changed during rollback", false),
      };
    }
    return { ok: true, value: { sessionId: emptySessionId, openMode: "create" } };
  }
  const checkpoint =
    input.kind === "fork" && input.checkpoint
      ? nativeCheckpointRefSchema.safeParse(input.checkpoint)
      : null;
  const boundaryIndex =
    input.kind === "rollbackLastTurn"
      ? source.turns.length - 2
      : source.turns.findIndex(
          (turn) =>
            checkpoint?.success && turn.checkpoint?.checkpointId === checkpoint.data.checkpointId,
        );
  const retained = source.turns[boundaryIndex];
  const boundaryId = retained?.checkpoint?.checkpointId ?? retained?.nativeTurnRef.nativeTurnKey;
  if (boundaryIndex < 0 || !boundaryId) {
    return {
      ok: false,
      error: error("checkpointNotFound", "Qoder Fork Checkpoint is unavailable", false),
    };
  }
  let derivedSessionId: string;
  try {
    const forked = await dependencies.forkSession({
      sourceSessionId: sourceRef.data.nativeSessionId,
      cwd: input.cwd,
      upToMessageId: boundaryId,
    });
    if (!forked.sessionId || forked.sessionId === sourceRef.data.nativeSessionId) {
      throw new Error("Qoder Fork returned an invalid Session identity");
    }
    derivedSessionId = forked.sessionId;
  } catch {
    return { ok: false, error: error("nativeFailure", "Qoder Native Fork failed", true) };
  }
  const cleanup = () =>
    dependencies
      .deleteSession({ sessionId: derivedSessionId, cwd: input.cwd })
      .catch(() => undefined);
  try {
    const [derived, sourceAfter] = await Promise.all([
      dependencies.readSnapshot(
        nativeSessionRefSchema.parse({
          harnessId: sourceRef.data.harnessId,
          nativeSessionId: derivedSessionId,
          formatVersion: 1,
        }),
        input.cwd,
      ),
      dependencies.readSnapshot(sourceRef.data, input.cwd),
    ]);
    const expected = source.turns.slice(0, boundaryIndex + 1).map(comparableTurn);
    const sourceIds = nativeIds(source);
    const derivedIds = nativeIds(derived);
    if (
      (input.kind === "rollbackLastTurn" && sourceAfter.turns.length !== source.turns.length) ||
      !isDeepStrictEqual(sourceAfter.turns.slice(0, source.turns.length), source.turns) ||
      !isDeepStrictEqual(derived.turns.map(comparableTurn), expected) ||
      derivedIds.size === 0 ||
      [...derivedIds].some((id) => sourceIds.has(id))
    ) {
      await cleanup();
      return {
        ok: false,
        error: error("protocolError", "Qoder Native Fork history is invalid", false),
      };
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { ok: true, value: { sessionId: derivedSessionId, openMode: "resume" } };
}
